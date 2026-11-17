const db = require('../config/db');

const FIELDS = `user_id, account_role, first_name, middle_name, last_name, username,
  email, job_position, hourly_rate, account_status, failed_pin_attempts, created_at`;

const COLUMNS = {
  firstName: 'first_name',
  middleName: 'middle_name',
  lastName: 'last_name',
  email: 'email',
  jobPosition: 'job_position',
  hourlyRate: 'hourly_rate',
  role: 'account_role',
};

async function list({ status, role, position, search, page, limit }) {
  const where = [];
  const params = [];
  if (status) { where.push('account_status = ?'); params.push(status); }
  if (role) { where.push('account_role = ?'); params.push(role); }
  if (position) { where.push('job_position = ?'); params.push(position); }
  if (search) {
    where.push('(first_name LIKE ? OR last_name LIKE ? OR username LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const pg = Math.max(parseInt(page, 10) || 1, 1);

  const [rows] = await db.query(
    `SELECT ${FIELDS} FROM \`user\` ${clause} ORDER BY last_name, first_name LIMIT ? OFFSET ?`,
    [...params, lim, (pg - 1) * lim]
  );
  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM \`user\` ${clause}`, params);
  return { rows, total, page: pg, limit: lim };
}

async function getById(id) {
  const [rows] = await db.query(`SELECT ${FIELDS} FROM \`user\` WHERE user_id = ?`, [id]);
  return rows[0] || null;
}

async function create(u) {
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

// Only fields in COLUMNS can ever be changed this way.
async function update(id, changes) {
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(COLUMNS)) {
    if (changes[key] !== undefined) {
      sets.push(`${col} = ?`);
      params.push(changes[key]);
    }
  }
  if (!sets.length) return false;
  params.push(id);
  await db.query(`UPDATE \`user\` SET ${sets.join(', ')} WHERE user_id = ?`, params);
  return true;
}

async function setStatus(id, status) {
  await db.query(
    'UPDATE `user` SET account_status = ?, failed_pin_attempts = 0 WHERE user_id = ?',
    [status, id]
  );
}

async function resetPin(id, pinHash) {
  await db.query(
    "UPDATE `user` SET pin_hash = ?, failed_pin_attempts = 0, account_status = IF(account_status = 'Locked', 'Active', account_status) WHERE user_id = ?",
    [pinHash, id]
  );
}

module.exports = { list, getById, create, update, setStatus, resetPin };