const db = require('../config/db'); 

const OT_MULTIPLIER = 1.25;

class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function computePay({ totalHours, overtimeHours, rate }) {
  const regularHours = Math.max(0, totalHours - overtimeHours);
  return round2(regularHours * rate + overtimeHours * rate * OT_MULTIPLIER);
}

/* ------------------------------ Cutoffs ------------------------------ */

async function createCutoff({ start_date, end_date }) {
  if (start_date > end_date) throw new AppError('start_date must be on or before end_date');

  const [overlap] = await db.query(
    `SELECT cutoff_id FROM payslip_cutoff
      WHERE start_date <= ? AND end_date >= ?`,
    [end_date, start_date]
  );
  if (overlap.length) throw new AppError('Cutoff overlaps an existing cutoff', 409);

  const [r] = await db.query(
    `INSERT INTO payslip_cutoff (start_date, end_date, status) VALUES (?, ?, 'Open')`,
    [start_date, end_date]
  );
  return { cutoff_id: r.insertId, start_date, end_date, status: 'Open' };
}

async function listCutoffs() {
  const [rows] = await db.query(
    `SELECT * FROM payslip_cutoff ORDER BY start_date DESC`
  );
  return rows;
}

/* --------------------------- Generate drafts -------------------------- */

/**
 * (Re)generate Draft payslips for every active employee in the cutoff.
 * Finalized payslips are never touched. Manually entered cash-advance
 * deductions on existing drafts are preserved (capped at the new gross).
 */
async function generatePayslips(cutoffId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[cutoff]] = await conn.query(
      `SELECT * FROM payslip_cutoff WHERE cutoff_id = ? FOR UPDATE`,
      [cutoffId]
    );
    if (!cutoff) throw new AppError('Cutoff not found', 404);
    if (cutoff.status === 'Closed') throw new AppError('Cutoff is closed', 409);

    const [employees] = await conn.query(
      `SELECT u.user_id, u.hourly_rate,
              COUNT(ar.record_id)                          AS days_worked,
              COALESCE(SUM(ar.total_hours_worked), 0)      AS total_hours,
              COALESCE(SUM(ar.overtime_hours), 0)          AS overtime_hours,
              COALESCE(SUM(ar.undertime_hours), 0)         AS undertime_hours
         FROM users u
         LEFT JOIN attendance_record ar
                ON ar.user_id = u.user_id
               AND ar.time_out IS NOT NULL
               AND ar.attendance_date BETWEEN ? AND ?
        WHERE u.status = 'active'
        GROUP BY u.user_id, u.hourly_rate`,
      [cutoff.start_date, cutoff.end_date]
    );

    const [existing] = await conn.query(
      `SELECT payslip_id, user_id, status, cash_advance_deduction
         FROM payslip WHERE cutoff_id = ? FOR UPDATE`,
      [cutoffId]
    );
    const byUser = new Map(existing.map((p) => [p.user_id, p]));

    let created = 0, updated = 0, skipped = 0;
    const missingRate = [];

    for (const e of employees) {
      const prev = byUser.get(e.user_id);
      if (prev && prev.status === 'Finalized') { skipped++; continue; }

      if (e.hourly_rate == null) missingRate.push(e.user_id);
      const rate = Number(e.hourly_rate || 0);
      const totalHours = round2(e.total_hours);
      const overtime = round2(e.overtime_hours);
      const undertime = round2(e.undertime_hours);
      const gross = computePay({ totalHours, overtimeHours: overtime, rate });
      const deduction = Math.min(Number(prev?.cash_advance_deduction || 0), gross);
      const net = round2(gross - deduction);

      if (prev) {
        await conn.query(
          `UPDATE payslip
              SET days_worked = ?, total_hours_worked = ?, overtime_hours = ?,
                  undertime_hours = ?, hourly_rate = ?, gross_pay = ?,
                  cash_advance_deduction = ?, net_pay = ?
            WHERE payslip_id = ?`,
          [e.days_worked, totalHours, overtime, undertime, rate, gross, deduction, net, prev.payslip_id]
        );
        updated++;
      } else {
        await conn.query(
          `INSERT INTO payslip
             (user_id, cutoff_id, days_worked, total_hours_worked, gross_pay,
              cash_advance_deduction, net_pay, overtime_hours, undertime_hours,
              hourly_rate, status)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'Draft')`,
          [e.user_id, cutoffId, e.days_worked, totalHours, gross, gross, overtime, undertime, rate]
        );
        created++;
      }
    }

    await conn.commit();
    return { cutoff_id: cutoffId, created, updated, skipped_finalized: skipped, missing_hourly_rate: missingRate };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/* ------------------------------ Review/edit --------------------------- */

async function listPayslipsForCutoff(cutoffId) {
  const [rows] = await db.query(
    `SELECT p.*, u.department
       FROM payslip p JOIN users u ON u.user_id = p.user_id
      WHERE p.cutoff_id = ?
      ORDER BY u.department, p.user_id`,
    [cutoffId]
  );
  return rows;
}

async function updateDraft(payslipId, { cash_advance_deduction }) {
  const deduction = Number(cash_advance_deduction);
  if (!Number.isFinite(deduction) || deduction < 0) {
    throw new AppError('cash_advance_deduction must be a number >= 0');
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.query(
      `SELECT * FROM payslip WHERE payslip_id = ? FOR UPDATE`,
      [payslipId]
    );
    if (!p) throw new AppError('Payslip not found', 404);
    if (p.status !== 'Draft') throw new AppError('Only Draft payslips can be edited', 409);
    if (deduction > Number(p.gross_pay)) {
      throw new AppError('Deduction cannot exceed gross pay');
    }

    const net = round2(Number(p.gross_pay) - deduction);
    await conn.query(
      `UPDATE payslip SET cash_advance_deduction = ?, net_pay = ? WHERE payslip_id = ?`,
      [round2(deduction), net, payslipId]
    );
    await conn.commit();
    return { ...p, cash_advance_deduction: round2(deduction), net_pay: net };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/* ------------------------------ Finalize ------------------------------ */

async function finalizeCutoff(cutoffId, adminUserId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[cutoff]] = await conn.query(
      `SELECT * FROM payslip_cutoff WHERE cutoff_id = ? FOR UPDATE`,
      [cutoffId]
    );
    if (!cutoff) throw new AppError('Cutoff not found', 404);
    if (cutoff.status === 'Closed') throw new AppError('Cutoff is already closed', 409);

    const [res] = await conn.query(
      `UPDATE payslip
          SET status = 'Finalized', finalized_by_user_id = ?
        WHERE cutoff_id = ? AND status = 'Draft'`,
      [adminUserId, cutoffId]
    );
    if (!res.affectedRows) throw new AppError('No draft payslips to finalize. Generate first.', 409);

    await conn.query(
      `UPDATE payslip_cutoff SET status = 'Closed' WHERE cutoff_id = ?`,
      [cutoffId]
    );
    await conn.commit();
    return { cutoff_id: cutoffId, finalized: res.affectedRows, status: 'Closed' };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/* ------------------------------ Employee view ------------------------- */

async function listOwnPayslips(userId) {
  const [rows] = await db.query(
    `SELECT p.*, c.start_date, c.end_date
       FROM payslip p JOIN payslip_cutoff c ON c.cutoff_id = p.cutoff_id
      WHERE p.user_id = ? AND p.status = 'Finalized'
      ORDER BY c.start_date DESC`,
    [userId]
  );
  return rows;
}

async function getPayslip(payslipId, requester) {
  const [[p]] = await db.query(
    `SELECT p.*, c.start_date, c.end_date
       FROM payslip p JOIN payslip_cutoff c ON c.cutoff_id = p.cutoff_id
      WHERE p.payslip_id = ?`,
    [payslipId]
  );
  // Same 404 for "missing" and "not yours/not finalized" to avoid leaking IDs.
  if (!p) throw new AppError('Payslip not found', 404);
  if (requester.role !== 'admin' && (p.user_id !== requester.user_id || p.status !== 'Finalized')) {
    throw new AppError('Payslip not found', 404);
  }
  return p;
}

module.exports = {
  createCutoff, listCutoffs, generatePayslips, listPayslipsForCutoff,
  updateDraft, finalizeCutoff, listOwnPayslips, getPayslip, AppError,
};