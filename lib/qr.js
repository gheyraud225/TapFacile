// Encodeur QR minimal — mode octet, correction d'erreur M (15 %), versions 1 à 3.
// Suffisant pour les URL de la forme https://tapfacile.ch/XXXX (25 caractères).
// Aucune dépendance externe : le code tourne tel quel dans un Worker Cloudflare.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function mul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

// Polynôme générateur de Reed-Solomon, coefficients du degré le plus fort au plus faible.
function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function reedSolomon(data, eccLength) {
  const gen = generator(eccLength);
  const buf = new Uint8Array(data.length + eccLength);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= mul(gen[j], factor);
  }
  return buf.slice(data.length);
}

// Versions 1 à 3 en correction M : un seul bloc de données, pas d'entrelacement.
const VERSIONS = [
  { version: 1, size: 21, dataWords: 16, eccWords: 10, alignCenters: [] },
  { version: 2, size: 25, dataWords: 28, eccWords: 16, alignCenters: [6, 18] },
  { version: 3, size: 29, dataWords: 44, eccWords: 26, alignCenters: [6, 22] },
];

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function pickVersion(byteLength) {
  for (const spec of VERSIONS) {
    // En-tête = 4 bits de mode + 8 bits de longueur.
    if (byteLength <= Math.floor((spec.dataWords * 8 - 12) / 8)) return spec;
  }
  return null;
}

function encodeData(bytes, spec) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4);        // mode octet
  push(bytes.length, 8);  // longueur (versions 1 à 9)
  for (const b of bytes) push(b, 8);

  const capacity = spec.dataWords * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0); // terminateur
  while (bits.length % 8 !== 0) bits.push(0);

  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    words.push(byte);
  }
  const padding = [0xec, 0x11];
  for (let i = 0; words.length < spec.dataWords; i++) words.push(padding[i % 2]);

  const data = Uint8Array.from(words);
  const ecc = reedSolomon(data, spec.eccWords);

  const out = [];
  for (const byte of data) for (let i = 7; i >= 0; i--) out.push((byte >> i) & 1);
  for (const byte of ecc) for (let i = 7; i >= 0; i--) out.push((byte >> i) & 1);
  return out;
}

function blankMatrix(size) {
  return Array.from({ length: size }, () => new Int8Array(size).fill(-1));
}

function placeFinder(m, reserved, row, col, size) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      const edge = r === -1 || r === 7 || c === -1 || c === 7;
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      m[rr][cc] = edge ? 0 : ring || core ? 1 : 0;
      reserved[rr][cc] = 1;
    }
  }
}

function placeAlignment(m, reserved, spec) {
  const centers = spec.alignCenters;
  const last = centers[centers.length - 1];
  for (const r of centers) {
    for (const c of centers) {
      // On saute les positions qui recouvrent les trois motifs de repérage.
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          m[r + dr][c + dc] = ring === 1 ? 0 : 1;
          reserved[r + dr][c + dc] = 1;
        }
      }
    }
  }
}

function placePatterns(m, reserved, spec) {
  const { size } = spec;
  placeFinder(m, reserved, 0, 0, size);
  placeFinder(m, reserved, 0, size - 7, size);
  placeFinder(m, reserved, size - 7, 0, size);
  placeAlignment(m, reserved, spec);

  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    m[6][i] = bit;
    reserved[6][i] = 1;
    m[i][6] = bit;
    reserved[i][6] = 1;
  }

  // Zones réservées à l'information de format.
  for (let i = 0; i < 9; i++) {
    if (reserved[8][i] !== 1) reserved[8][i] = 1;
    if (reserved[i][8] !== 1) reserved[i][8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = 1;
    reserved[size - 1 - i][8] = 1;
  }
  reserved[size - 8][8] = 1;
}

function formatBits(mask) {
  const data = (0b00 << 3) | mask; // correction M = 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

// Première copie : les quinze positions reçoivent les bits du plus fort au plus faible.
const FORMAT_POSITIONS = [
  [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
  [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
];

function placeFormat(m, mask, size) {
  const fmt = formatBits(mask);

  FORMAT_POSITIONS.forEach(([r, c], i) => {
    m[r][c] = (fmt >> (14 - i)) & 1;
  });

  // Seconde copie : bits 0 à 7 sur la ligne 8 en partant de la droite,
  // bits 8 à 14 sur la colonne 8 en remontant vers le bas du symbole.
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >> i) & 1;
    if (i < 8) m[8][size - 1 - i] = bit;
    else m[size - 15 + i][8] = bit;
  }

  m[size - 8][8] = 1; // module sombre, toujours présent
}

function placeData(m, reserved, bits, mask, size) {
  const maskFn = MASKS[mask];
  let index = 0;
  let upward = true;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // la colonne 6 porte le motif de synchronisation
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset++) {
        const c = col - offset;
        if (reserved[row][c]) continue;
        let bit = index < bits.length ? bits[index++] : 0;
        if (maskFn(row, c)) bit ^= 1;
        m[row][c] = bit;
      }
    }
    upward = !upward;
  }
}

function penalty(m, size) {
  let score = 0;

  // Règle 1 : suites de cinq modules identiques ou plus.
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const cur = horizontal ? m[i][j] : m[j][i];
        const prev = horizontal ? m[i][j - 1] : m[j - 1][i];
        if (cur === prev) {
          run++;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // Règle 2 : blocs 2x2 de même couleur.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // Règle 3 : motifs 1:1:3:1:1 assimilables à un motif de repérage.
  const a = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const b = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (get) => {
    let found = 0;
    for (let i = 0; i + 11 <= size; i++) {
      let okA = true;
      let okB = true;
      for (let j = 0; j < 11; j++) {
        const v = get(i + j);
        if (v !== a[j]) okA = false;
        if (v !== b[j]) okB = false;
      }
      if (okA) found++;
      if (okB) found++;
    }
    return found;
  };
  for (let i = 0; i < size; i++) {
    score += 40 * matches((j) => m[i][j]);
    score += 40 * matches((j) => m[j][i]);
  }

  // Règle 4 : déséquilibre entre modules sombres et clairs.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/**
 * Construit la matrice de modules du QR code.
 * @param {string} text contenu à encoder
 * @returns {number[][]} matrice carrée de 0 (clair) et 1 (sombre)
 */
export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  const spec = pickVersion(bytes.length);
  if (!spec) throw new Error(`contenu trop long pour l'encodeur intégré (${bytes.length} octets, maximum 42)`);

  const bits = encodeData(bytes, spec);
  const { size } = spec;

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = blankMatrix(size);
    const reserved = blankMatrix(size).map((row) => new Int8Array(row.length));
    placePatterns(m, reserved, spec);
    placeData(m, reserved, bits, mask, size);
    placeFormat(m, mask, size);
    const score = penalty(m, size);
    if (!best || score < best.score) best = { score, matrix: m };
  }

  return best.matrix.map((row) => Array.from(row));
}

/**
 * Rend le QR code en SVG autonome (aucune image externe, aucun script).
 * @param {string} text contenu à encoder
 * @param {{margin?: number, dark?: string, light?: string}} [options]
 * @returns {string} document SVG
 */
export function qrSvg(text, options = {}) {
  const margin = options.margin ?? 4;
  const dark = options.dark ?? '#1c1f22';
  const light = options.light ?? '#ffffff';
  const matrix = qrMatrix(text);
  const size = matrix.length;
  const total = size + margin * 2;

  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) path += `M${c + margin},${r + margin}h1v1h-1z`;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `width="${total * 8}" height="${total * 8}" shape-rendering="crispEdges" role="img">` +
    `<title>QR code ${escapeXml(text)}</title>` +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path fill="${dark}" d="${path}"/>` +
    `</svg>`
  );
}

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (ch) => {
    switch (ch) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '"': return '&quot;';
      default: return '&apos;';
    }
  });
}
