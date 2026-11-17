const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./practice-input/p00.in', 'utf8'));
console.log(Object.keys(data));
console.log('Known:', data.known);
console.log('Forecast length:', data.forecast.length);
// console.log('Comparables count:', data.comparables.length);
