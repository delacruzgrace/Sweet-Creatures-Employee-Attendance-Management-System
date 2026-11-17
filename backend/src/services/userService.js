const db = require('../config/db');

const SAFE_FIELDS = `user_id, account_role, first_name, middle_name, last_name,
  username, email, job_position, hourly_rate, account_status, created_at`;

async function findByUsername(username) {
  const [rows] = await db.query('SELECT * FROM `user` WHERE username = ?', [username]);
  return rows[0] || null;
}

async function findById(id) {
  const [rows] = await db.query(`SELECT ${SAFE_FIELDS} FROM \`user\` WHERE user_id = ?`, [id]);
  return rows[0] || null;
}

async function createUser(u) {
  const [result] = await db.query(
    `INSERT INTO \`user\`
      (account_role, first_name, middle_name, last_name, username, email,
       pin_hash, job_position, hourly_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [u.role, u.firstName, u.middleName || null, u.lastName, u.username,
     u.email, u.pinHash, u.jobPosition || null, u.hourlyRate ?? null]
  );
  return result.insertId;
}

// Increments the counter and locks the account in one atomic statement.
async function recordFailedAttempt(userId, maxAttempts) {
  await db.query(
    `UPDATE \`user\`
     SET account_status = IF(failed_pin_attempts + 1 >= ?, 'Locked', account_status),
         failed_pin_attempts = failed_pin_attempts + 1
     WHERE user_id = ?`,
    [maxAttempts, userId]
  );
}

async function resetFailedAttempts(userId) {
  await db.query('UPDATE `user` SET failed_pin_attempts = 0 WHERE user_id = ?', [userId]);
}

async function unlock(userId) {
  const [result] = await db.query(
    "UPDATE `user` SET account_status = 'Active', failed_pin_attempts = 0 WHERE user_id = ?",
    [userId]
  );
  return result.affectedRows > 0;
}

module.exports = {
  findByUsername, findById, createUser,
  recordFailedAttempt, resetFailedAttempts, unlock,
};