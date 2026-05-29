function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers,
  });
}

function normalizeClassCode(value) {
  return String(value || "").trim().toUpperCase();
}

function isValidClassCode(code) {
  return /^(?:[1-6])[AB]$/.test(code);
}

function normalizeMonth(value) {
  const month = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(month) || month < 1 || month > 12) return null;
  return month;
}

function normalizeYear(value) {
  const year = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(year) || year < 2000 || year > 2100) return null;
  return year;
}

const MONTH_NAMES = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

const WEEKDAY_SHORT = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

const ACADEMIC_YEAR = "2025/2026";
const SEMESTER_LABEL = "Ganjil";

function monthName(month) {
  return MONTH_NAMES[(month || 1) - 1] || "";
}

function weekdayShort(date) {
  return WEEKDAY_SHORT[new Date(date).getDay()];
}

function isoDate(year, month, day) {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

async function getColumnNames(env, tableName) {
  const result = await env.DB.prepare(`PRAGMA table_info(${tableName})`).all();
  return new Set((result.results || []).map((row) => row.name));
}

async function ensureSchema(env) {
  const studentCols = await getColumnNames(env, "students");
  if (!studentCols.has("gender")) {
    await env.DB.prepare(`ALTER TABLE students ADD COLUMN gender TEXT NOT NULL DEFAULT 'L'`).run();
  }

  const classCols = await getColumnNames(env, "classes");
  if (!classCols.has("wali_kelas")) {
    await env.DB.prepare(`ALTER TABLE classes ADD COLUMN wali_kelas TEXT NOT NULL DEFAULT ''`).run();
  }

  await env.DB.prepare(`
    UPDATE classes
    SET wali_kelas = 'Fahmi Arif'
    WHERE code = '4B' AND (wali_kelas IS NULL OR wali_kelas = '')
  `).run();
}

async function ensureClasses(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM classes").first();
  if ((row?.total || 0) === 0) {
    const statements = [
      ["1A", "Kelas 1A", 1],
      ["1B", "Kelas 1B", 2],
      ["2A", "Kelas 2A", 3],
      ["2B", "Kelas 2B", 4],
      ["3A", "Kelas 3A", 5],
      ["3B", "Kelas 3B", 6],
      ["4A", "Kelas 4A", 7],
      ["4B", "Kelas 4B", 8],
      ["5A", "Kelas 5A", 9],
      ["5B", "Kelas 5B", 10],
      ["6A", "Kelas 6A", 11],
      ["6B", "Kelas 6B", 12],
    ].map(([code, name, sortOrder]) => env.DB.prepare(
      "INSERT INTO classes (code, name, sort_order, wali_kelas) VALUES (?, ?, ?, ?)"
    ).bind(code, name, sortOrder, code === "4B" ? "Fahmi Arif" : ""));
    await env.DB.batch(statements);
  }
}

function badRequest(message) {
  return json({ ok: false, error: message }, { status: 400 });
}

function notFound(message = "Route tidak ditemukan") {
  return json({ ok: false, error: message }, { status: 404 });
}

async function getClasses(env) {
  const result = await env.DB.prepare(
    "SELECT code, name, sort_order AS sortOrder, wali_kelas AS waliKelas FROM classes ORDER BY sort_order, code"
  ).all();
  return result.results || [];
}

async function getClassByCode(env, classCode) {
  const result = await env.DB.prepare(
    "SELECT code, name, sort_order AS sortOrder, wali_kelas AS waliKelas FROM classes WHERE code = ?"
  ).bind(classCode).first();
  return result || null;
}

async function getStudents(env, classCode, includeInactive = false) {
  const sql = includeInactive
    ? `SELECT id, class_code AS classCode, student_order AS studentOrder, nisn, name, gender, active
       FROM students
       WHERE class_code = ?
       ORDER BY student_order, id`
    : `SELECT id, class_code AS classCode, student_order AS studentOrder, nisn, name, gender, active
       FROM students
       WHERE class_code = ? AND active = 1
       ORDER BY student_order, id`;
  const result = await env.DB.prepare(sql).bind(classCode).all();
  return result.results || [];
}

async function getAttendance(env, classCode, date) {
  const result = await env.DB.prepare(
    `SELECT student_id AS studentId, status, note
     FROM attendance
     WHERE class_code = ? AND date = ?`
  ).bind(classCode, date).all();
  return result.results || [];
}

async function getAttendanceRange(env, classCode, startDate, endDate) {
  const result = await env.DB.prepare(
    `SELECT date, student_id AS studentId, status, note
     FROM attendance
     WHERE class_code = ? AND date BETWEEN ? AND ?`
  ).bind(classCode, startDate, endDate).all();
  return result.results || [];
}

async function clearAttendance(env, classCode, date) {
  const result = await env.DB.prepare(
    "DELETE FROM attendance WHERE class_code = ? AND date = ?"
  ).bind(classCode, date).run();
  return result.meta?.changes || 0;
}

async function upsertAttendance(env, classCode, date, records, replace = false) {
  if (!Array.isArray(records)) return 0;
  const statements = [];
  if (replace) {
    statements.push(
      env.DB.prepare("DELETE FROM attendance WHERE class_code = ? AND date = ?").bind(classCode, date)
    );
  }

  for (const row of records) {
    const studentId = Number(row?.studentId);
    const status = String(row?.status || "").trim().toUpperCase();
    const note = String(row?.note || "").trim();
    if (!studentId || !["H", "S", "I", "A"].includes(status)) continue;
    statements.push(
      env.DB.prepare(
        `INSERT INTO attendance (date, class_code, student_id, status, note, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(date, class_code, student_id)
         DO UPDATE SET status = excluded.status, note = excluded.note, updated_at = CURRENT_TIMESTAMP`
      ).bind(date, classCode, studentId, status, note)
    );
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }
  return statements.length;
}

async function saveRoster(env, classCode, students) {
  if (!Array.isArray(students)) return 0;
  const statements = [];
  const normalized = students
    .map((row) => ({
      id: row?.id ? Number(row.id) : null,
      nisn: String(row?.nisn || "").trim(),
      name: String(row?.name || "").trim(),
      gender: String(row?.gender || "L").trim().toUpperCase().startsWith("P") ? "P" : "L",
      active: row?.active === false || row?.active === 0 || row?.active === "0" ? 0 : 1,
    }))
    .filter(row => row.name.length > 0 || row.id);

  for (const [index, row] of normalized.entries()) {
    const studentOrder = index + 1;
    if (row.id) {
      statements.push(
        env.DB.prepare(
          `UPDATE students
           SET nisn = ?, name = ?, gender = ?, student_order = ?, active = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND class_code = ?`
        ).bind(row.nisn, row.name, row.gender, studentOrder, row.active, row.id, classCode)
      );
    } else if (row.name) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO students (class_code, student_order, nisn, name, gender, active)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(classCode, studentOrder, row.nisn, row.name, row.gender, row.active)
      );
    }
  }

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }
  return statements.length;
}

async function moveRoster(env, fromClassCode, toClassCode) {
  const source = await env.DB.prepare(
    `SELECT id, nisn, name, gender, student_order AS studentOrder
     FROM students
     WHERE class_code = ? AND active = 1
     ORDER BY student_order, id`
  ).bind(fromClassCode).all();

  const rows = source.results || [];
  if (rows.length === 0) return 0;

  const targetMaxRow = await env.DB.prepare(
    `SELECT COALESCE(MAX(student_order), 0) AS maxOrder
     FROM students
     WHERE class_code = ?`
  ).bind(toClassCode).first();
  let nextOrder = Number(targetMaxRow?.maxOrder || 0) + 1;

  const statements = rows.map((row) => env.DB.prepare(
    `UPDATE students
     SET class_code = ?, student_order = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND class_code = ?`
  ).bind(toClassCode, nextOrder++, row.id, fromClassCode));

  await env.DB.batch(statements);
  return rows.length;
}

async function deleteClassRoster(env, classCode) {
  const statements = [
    env.DB.prepare("DELETE FROM attendance WHERE class_code = ?").bind(classCode),
    env.DB.prepare("DELETE FROM students WHERE class_code = ?").bind(classCode),
  ];
  await env.DB.batch(statements);
  return true;
}

async function getMonthlyReport(env, classCode, month, year) {
  const classRow = await getClassByCode(env, classCode);
  if (!classRow) return null;

  const totalDays = daysInMonth(year, month);
  const startDate = isoDate(year, month, 1);
  const endDate = isoDate(year, month, totalDays);
  const students = await getStudents(env, classCode, false);
  const attendanceRows = await getAttendanceRange(env, classCode, startDate, endDate);

  const attendanceByStudent = new Map();
  for (const row of attendanceRows) {
    if (!attendanceByStudent.has(String(row.studentId))) {
      attendanceByStudent.set(String(row.studentId), {});
    }
    attendanceByStudent.get(String(row.studentId))[row.date] = row.status;
  }

  const days = Array.from({ length: totalDays }, (_, idx) => {
    const day = idx + 1;
    const date = isoDate(year, month, day);
    return {
      date,
      day,
      weekday: weekdayShort(date),
    };
  });

  const studentRows = students.map((student) => {
    const byDate = attendanceByStudent.get(String(student.id)) || {};
    const totals = { H: 0, S: 0, I: 0, A: 0 };
    for (const status of Object.values(byDate)) {
      if (totals[status] !== undefined) totals[status] += 1;
    }
    return {
      id: student.id,
      nisn: student.nisn || "",
      name: student.name || "",
      gender: student.gender || "L",
      studentOrder: student.studentOrder || 0,
      attendance: byDate,
      totals,
    };
  });

  return {
    class: {
      code: classRow.code,
      name: classRow.name,
      waliKelas: classRow.waliKelas || (classCode === "4B" ? "Fahmi Arif" : ""),
    },
    academicYear: ACADEMIC_YEAR,
    semester: SEMESTER_LABEL,
    month,
    year,
    monthLabel: `${monthName(month)} ${year}`,
    days,
    students: studentRows,
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      }
    });
  }

  try {
    await ensureSchema(env);
    await ensureClasses(env);

    const action = url.searchParams.get("action") || "classes";
    const method = request.method.toUpperCase();

    if (method === "GET") {
      if (action === "classes") {
        return json({ ok: true, classes: await getClasses(env) });
      }

      if (action === "students") {
        const classCode = normalizeClassCode(url.searchParams.get("classCode"));
        const includeInactive = String(url.searchParams.get("includeInactive") || "") === "1";
        if (!isValidClassCode(classCode)) return badRequest("Kode kelas tidak valid.");
        return json({ ok: true, students: await getStudents(env, classCode, includeInactive) });
      }

      if (action === "attendance") {
        const classCode = normalizeClassCode(url.searchParams.get("classCode"));
        const date = String(url.searchParams.get("date") || "").trim();
        if (!isValidClassCode(classCode)) return badRequest("Kode kelas tidak valid.");
        if (!date) return badRequest("Tanggal wajib diisi.");
        return json({ ok: true, records: await getAttendance(env, classCode, date) });
      }

      if (action === "monthlyReport") {
        const classCode = normalizeClassCode(url.searchParams.get("classCode"));
        const month = normalizeMonth(url.searchParams.get("month"));
        const year = normalizeYear(url.searchParams.get("year"));
        if (!isValidClassCode(classCode)) return badRequest("Kode kelas tidak valid.");
        if (!month || !year) return badRequest("Bulan atau tahun tidak valid.");
        const report = await getMonthlyReport(env, classCode, month, year);
        if (!report) return notFound("Kelas tidak ditemukan.");
        return json({ ok: true, report });
      }

      return notFound();
    }

    if (method === "POST") {
      const payload = await request.json().catch(() => ({}));
      const actionPost = String(payload?.action || action || "").trim();

      if (actionPost === "saveAttendance") {
        const classCode = normalizeClassCode(payload.classCode);
        const date = String(payload.date || "").trim();
        if (!isValidClassCode(classCode)) return badRequest("Kode kelas tidak valid.");
        if (!date) return badRequest("Tanggal wajib diisi.");
        const saved = await upsertAttendance(env, classCode, date, payload.records || [], Boolean(payload.replace));
        return json({ ok: true, saved });
      }

      if (actionPost === "saveRoster") {
        const classCode = normalizeClassCode(payload.classCode);
        if (!isValidClassCode(classCode)) return badRequest("Kode kelas tidak valid.");
        const saved = await saveRoster(env, classCode, payload.students || []);
        return json({ ok: true, saved });
      }

      if (actionPost === "moveRoster" || actionPost === "copyRoster") {
        const fromClassCode = normalizeClassCode(payload.fromClassCode);
        const toClassCode = normalizeClassCode(payload.toClassCode);
        if (!isValidClassCode(fromClassCode) || !isValidClassCode(toClassCode)) {
          return badRequest("Kode kelas sumber atau tujuan tidak valid.");
        }
        const moved = await moveRoster(env, fromClassCode, toClassCode);
        return json({ ok: true, moved });
      }

      if (actionPost === "clearAttendance") {
        const classCode = normalizeClassCode(payload.classCode);
        const date = String(payload.date || "").trim();
        if (!isValidClassCode(classCode)) return badRequest("Kode kelas tidak valid.");
        if (!date) return badRequest("Tanggal wajib diisi.");
        const cleared = await clearAttendance(env, classCode, date);
        return json({ ok: true, cleared });
      }

      if (actionPost === "deleteClassRoster") {
        const classCode = normalizeClassCode(payload.classCode);
        if (!isValidClassCode(classCode)) return badRequest("Kode kelas tidak valid.");
        await deleteClassRoster(env, classCode);
        return json({ ok: true });
      }

      return notFound();
    }

    return notFound();
  } catch (error) {
    return json({
      ok: false,
      error: error?.message || "Terjadi kesalahan server",
    }, { status: 500 });
  }
}
