const bcrypt = require('bcryptjs');
const db = require('../config/db');

async function main() {
  const [username, email, pin] = process.argv.slice(2);

  if (!username || !email || !/^\d{4,6}$/.test(pin || '')) {
    console.log('Usage: node src/scripts/createAdmin.js <username> <email> <4-6 digit pin>');
    process.exit(1);
  }

  const pinHash = await bcrypt.hash(pin, 10);
  await db.query(
    `INSERT INTO \`user\` (account_role, first_name, last_name, username, email, pin_hash)
     VALUES ('Admin', 'Admin', 'User', ?, ?, ?)`,
    [username.toLowerCase(), email.toLowerCase(), pinHash]
  );
  console.log(`Admin "${username}" created.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});