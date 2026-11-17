const db = require('../config/db'); 

const DEFAULT_SHIFT = {
  start_time: '09:00:00',
  end_time: '18:00:00',
  grace_minutes: 15,
  break_minutes: 60,
};

class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Local-date string (YYYY-MM-DD) for attendance_date. */
function toDateString(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Build a Date for today at an 'HH:MM:SS' shift time. */
function atTime(baseDate, hhmmss) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  const d = new Date(baseDate);
  d.setHours(h, m, s || 0, 0);
  return d;
}

async function getUserShift(conn, userId) {
  const [rows] = await conn.query(
    `SELECT s.start_time, s.end_time, s.grace_minutes, s.break_minutes
       FROM users u
       LEFT JOIN shifts s ON s.shift_id = u.shift_id
      WHERE u.user_id = ?`,
    [userId]
  );
  if (!rows.length) throw new AppError('User not found', 404);
  const s = rows[0];
  return {
    start_time: s.start_time || DEFAULT_SHIFT.start_time,
    end_time: s.end_time || DEFAULT_SHIFT.end_time,
    grace_minutes: s.grace_minutes ?? DEFAULT_SHIFT.grace_minutes,
    break_minutes: s.break_minutes ?? DEFAULT_SHIFT.break_minutes,
  };
}

/**
 * Clock in: server timestamp, one shift per day, auto Present/Late.
 */
async function clockIn(userId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const now = new Date();
    const today = toDateString(now);

    // Lock this user's recent rows so concurrent requests can't double clock-in.
    const [open] = await conn.query(
      `SELECT record_id FROM attendance_record
        WHERE user_id = ? AND time_out IS NULL
        FOR UPDATE`,
      [userId]
    );
    if (open.length) {
      throw new AppError('You already have an active open shift. Clock out first.', 409);
    }

    const [existing] = await conn.query(
      `SELECT record_id FROM attendance_record
        WHERE user_id = ? AND attendance_date = ?
        FOR UPDATE`,
      [userId, today]
    );
    if (existing.length) {
      throw new AppError('You have already clocked in today.', 409);
    }

    const shift = await getUserShift(conn, userId);
    const lateAfter = new Date(
      atTime(now, shift.start_time).getTime() + shift.grace_minutes * 60000
    );
    const status = now > lateAfter ? 'Late' : 'Present';

    const [result] = await conn.query(
      `INSERT INTO attendance_record (user_id, attendance_date, time_in, status)
       VALUES (?, ?, ?, ?)`,
      [userId, today, now, status]
    );

    await conn.commit();
    return {
      record_id: result.insertId,
      user_id: userId,
      attendance_date: today,
      time_in: now,
      status,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Clock out: close the open record, compute total / overtime / undertime.
 */
async function clockOut(userId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT * FROM attendance_record
        WHERE user_id = ? AND time_out IS NULL
        ORDER BY record_id DESC LIMIT 1
        FOR UPDATE`,
      [userId]
    );
    if (!rows.length) {
      throw new AppError('No active shift found. Clock in first.', 409);
    }
    const rec = rows[0];

    const now = new Date();
    const timeIn = new Date(rec.time_in);
    const shift = await getUserShift(conn, userId);

    // Worked minutes, minus the recorded break if there is one.
    let workedMs = now - timeIn;
    if (rec.break_start && rec.return_from_break) {
      workedMs -= new Date(rec.return_from_break) - new Date(rec.break_start);
    }
    const totalHours = round2(Math.max(0, workedMs) / 3600000);

    // Scheduled hours = shift length minus unpaid break allowance.
    const shiftMs =
      atTime(now, shift.end_time) - atTime(now, shift.start_time) -
      shift.break_minutes * 60000;
    const scheduledHours = Math.max(0, shiftMs / 3600000);

    const overtime = round2(Math.max(0, totalHours - scheduledHours));
    const undertime = round2(Math.max(0, scheduledHours - totalHours));

    await conn.query(
      `UPDATE attendance_record
          SET time_out = ?, total_hours_worked = ?,
              overtime_hours = ?, undertime_hours = ?
        WHERE record_id = ?`,
      [now, totalHours, overtime, undertime, rec.record_id]
    );

    await conn.commit();
    return {
      record_id: rec.record_id,
      time_in: rec.time_in,
      time_out: now,
      total_hours_worked: totalHours,
      overtime_hours: overtime,
      undertime_hours: undertime,
      status: rec.status,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Query logs. Regular employees are always scoped to their own user_id.
 */
async function getRecords(requester, filters = {}) {
  const privileged = ['admin', 'manager'].includes(requester.role);
  const where = [];
  const params = [];

  if (privileged) {
    if (filters.user_id) {
      where.push('ar.user_id = ?');
      params.push(filters.user_id);
    }
    if (filters.department) {
      where.push('u.department = ?');
      params.push(filters.department);
    }
  } else {
    where.push('ar.user_id = ?');
    params.push(requester.user_id);
  }

  if (filters.date_from) {
    where.push('ar.attendance_date >= ?');
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    where.push('ar.attendance_date <= ?');
    params.push(filters.date_to);
  }
  if (filters.status) {
    where.push('ar.status = ?');
    params.push(filters.status);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(filters.limit, 10) || 20));
  const offset = (page - 1) * limit;

  const fromSql = `FROM attendance_record ar JOIN users u ON u.user_id = ar.user_id ${whereSql}`;

  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total ${fromSql}`, params);
  const [data] = await db.query(
    `SELECT ar.*, u.department
       ${fromSql}
      ORDER BY ar.attendance_date DESC, ar.record_id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return { data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}

module.exports = { clockIn, clockOut, getRecords, AppError };