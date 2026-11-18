import fs from "node:fs";

const P = "C:\\Users\\32957\\AppData\\Local\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe";
const buf = fs.readFileSync(P);
const MAGIC = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");

const hits = [];
let i = 0;
while ((i = buf.indexOf(MAGIC, i)) >= 0) {
  hits.push(i);
  i += MAGIC.length;
}
console.log("magic hits:", hits.length, hits.slice(0, 5));

const count = (needle, enc = "latin1") => {
  const b = Buffer.from(needle, enc);
  let n = 0;
  let j = 0;
  while ((j = buf.indexOf(b, j)) >= 0) {
    n++;
    j += b.length;
  }
  return n;
};

for (const at of hits) {
  const s = Math.max(0, at - 40);
  console.log(`\n@${at}`);
  console.log("  hex:", buf.subarray(s, at).toString("hex"));
  console.log("  asc:", buf.subarray(s, at).toString("latin1").replace(/[^\x20-\x7e]/g, "."));
}

console.log("\n关键词出现次数:");
for (const k of ["ELECTRONASAR", "asarIntegrity", "ELECTRONASARFUSE", "app.asar"]) {
  console.log(`  ${k}: latin1=${count(k)} utf16le=${count(k, "utf16le")}`);
}
