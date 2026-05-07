
const fs = require('fs');
const content = fs.readFileSync('src/MainApp.tsx', 'utf8');
let bracketCount = 0;
const lines = content.split('\n');
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (let j = 0; j < line.length; j++) {
    if (line[j] === '[') bracketCount++;
    if (line[j] === ']') bracketCount--;
  }
  if (bracketCount < 0) {
    console.log(`Bracket imbalance at line ${i + 1}: ${bracketCount}`);
    console.log(line);
    // process.exit(0); // Optional: stop at first error
  }
}
console.log(`Final Bracket Count: ${bracketCount}`);
