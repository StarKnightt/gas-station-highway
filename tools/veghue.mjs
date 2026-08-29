import fs from "node:fs";
import { PNG } from "pngjs";
// No region argument, deliberately. Counts every mid-dark pixel in the frame and
// asks whether it is green-dominant or red-dominant. Foliage is the great
// majority of mid-dark pixels in these poses, and the critic's complaint was a
// hue claim ("wood-brown", "no green"), so hue is what gets counted.
for (const f of process.argv.slice(2)) {
  const p = PNG.sync.read(fs.readFileSync(f));
  let green = 0, brown = 0, neutral = 0;
  for (let i = 0; i < p.data.length; i += 4) {
    const r = p.data[i], g = p.data[i + 1], b = p.data[i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (l < 18 || l > 110) continue;      // skip silhouettes and lit surfaces
    if (g - r >= 3) green++;
    else if (r - g >= 6) brown++;
    else neutral++;
  }
  const n = green + brown + neutral || 1;
  console.log(
    `${f.split(/[\/]/).pop().padEnd(13)} green ${((green / n) * 100).toFixed(1).padStart(5)}%   ` +
      `brown ${((brown / n) * 100).toFixed(1).padStart(5)}%   neutral ${((neutral / n) * 100).toFixed(1).padStart(5)}%`
  );
}
