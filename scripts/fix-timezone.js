// This script shows the fix needed for timezone handling
// The actual fix should be applied directly to routes/users.js

console.log("To fix the timezone issue:");
console.log("1. Replace all 'new Date()' with Asia/Colombo timezone calculations");
console.log("2. Use Intl.DateTimeFormat with timeZone: 'Asia/Colombo'");
console.log("3. Update week boundary calculations to use Colombo time");
