import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  LayoutDashboard,
  Users,
  Clock3,
  ChartNoAxesCombined,
  FileText,
  Settings,
  Search,
  Bell,
  ChevronDown,
  Plus,
  Download,
  LogOut,
  Menu,
  X,
  CalendarDays,
  ArrowUpRight,
  CircleCheck,
  CircleAlert,
  BriefcaseBusiness,
  UserRound,
  ShieldCheck,
  LogIn,
  RefreshCw,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  BarChart,
  Bar,
} from "recharts";
import "./style.css";
const api = async (path, opts = {}) => {
  const r = await fetch("/api" + path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  let d;
  try {
    d = await r.json();
  } catch {
    d = {};
  }
  if (!r.ok) throw new Error(d.detail || `Request failed (${r.status})`);
  return d;
};
const fmt = (v) => (v == null ? "—" : v);
const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);
function App() {
  const [session, setSession] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("hrone-demo-session"));
    } catch {
      return null;
    }
  });
  const [page, setPage] = useState("Dashboard"),
    [employees, setEmployees] = useState([]),
    [attendance, setAttendance] = useState([]),
    [summary, setSummary] = useState([]),
    [leaderboard, setLeaderboard] = useState([]),
    [monthly, setMonthly] = useState(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [search, setSearch] = useState(""),
    [monthValue, setMonthValue] = useState(month),
    [showAdd, setShowAdd] = useState(false),
    [mobileNav, setMobileNav] = useState(false),
    [form, setForm] = useState({
      emp_code: "",
      name: "",
      email: "",
      department: "Engineering",
      shift_start: "09:30",
      shift_end: "18:30",
      joined_on: today,
    });
  const [login, setLogin] = useState({
    role: "admin",
    emp_code: "EMP0002",
    name: "Navneeth S",
  });
  const isAdmin = session?.role === "admin";
  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      const [e, a, s, l] = await Promise.all([
        api("/employees?page=1&page_size=100"),
        api("/attendance?page=1&page_size=100"),
        api(`/analytics/departments/summary?month=${monthValue}`),
        api(`/analytics/leaderboard/late?month=${monthValue}&limit=10`),
      ]);
      setEmployees(e.items || []);
      setAttendance(a.items || []);
      setSummary(s.items || []);
      setLeaderboard(l.items || []);
      if (session?.role === "employee" && session.emp_code) {
        try {
          setMonthly(
            await api(
              `/analytics/employees/${encodeURIComponent(session.emp_code)}/monthly?month=${monthValue}`,
            ),
          );
        } catch {
          setMonthly(null);
        }
      } else setMonthly(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (session) refresh();
  }, [session?.role, session?.emp_code, monthValue]);
  const filteredEmployees = useMemo(
    () =>
      employees.filter((e) =>
        [e.emp_code, e.name, e.email, e.department]
          .join(" ")
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [employees, search],
  );
  const visibleAttendance = useMemo(
    () =>
      attendance.filter(
        (a) =>
          (isAdmin || a.emp_code === session?.emp_code) &&
          [a.emp_code, a.status, a.date]
            .join(" ")
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [attendance, search, isAdmin, session],
  );
  const presentToday = attendance.filter(
    (a) => a.date === today && ["PRESENT", "WFH", "ON_DUTY"].includes(a.status),
  ).length;
  const lateToday = attendance.filter(
    (a) => a.date === today && (a.late_minutes || 0) > 0,
  ).length;
  const avgRate = summary.length
    ? Math.round(
        (summary.reduce(
          (n, x) => n + (x.headcount ? x.present_days / x.headcount : 0),
          0,
        ) /
          summary.length) *
          100,
      )
    : 0;
  function signIn(e) {
    e.preventDefault();
    const s = {
      role: login.role,
      emp_code: login.emp_code.trim().toUpperCase(),
      name:
        login.name.trim() ||
        (login.role === "admin" ? "Administrator" : "Employee"),
    };
    localStorage.setItem("hrone-demo-session", JSON.stringify(s));
    setSession(s);
    setPage("Dashboard");
    setError("");
  }
  function signOut() {
    localStorage.removeItem("hrone-demo-session");
    setSession(null);
    setPage("Dashboard");
  }
  async function addEmployee(e) {
    e.preventDefault();
    try {
      await api("/employees", { method: "POST", body: JSON.stringify(form) });
      setShowAdd(false);
      setNotice("Employee created successfully");
      setForm({
        emp_code: "",
        name: "",
        email: "",
        department: "Engineering",
        shift_start: "09:30",
        shift_end: "18:30",
        joined_on: today,
      });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }
  async function punch(kind) {
    try {
      const body = { emp_code: session.emp_code };
      await api(`/attendance/punch-${kind}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setNotice(kind === "in" ? "Punch-in recorded" : "Punch-out recorded");
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  }
  function downloadCSV() {
    const rows = page === "Employees" ? filteredEmployees : visibleAttendance;
    const keys =
      page === "Employees"
        ? [
            "emp_code",
            "name",
            "email",
            "department",
            "shift_start",
            "shift_end",
            "joined_on",
          ]
        : [
            "emp_code",
            "date",
            "status",
            "punch_in",
            "punch_out",
            "work_hours",
            "late_minutes",
            "overtime_minutes",
          ];
    const csv = [
      keys.join(","),
      ...rows.map((r) => keys.map((k) => JSON.stringify(r[k] ?? "")).join(",")),
    ].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `hrone-${page.toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  if (!session)
    return (
      <div className="login-shell">
        <div className="login-art">
          <div className="brand">
            <span className="brand-mark">H</span>
            <span>
              HROne<span className="brand-light"> peopleOS</span>
            </span>
          </div>
          <div className="hero-copy">
            <span className="eyebrow">PEOPLE. PROCESSES. PROGRESS.</span>
            <h1>
              Work feels better
              <br />
              when everything
              <br />
              <em>works together.</em>
            </h1>
            <p>
              A thoughtful workspace for attendance, people operations and
              workforce insights.
            </p>
            <div className="hero-pills">
              <span>
                <ShieldCheck size={16} /> Role-based views
              </span>
              <span>
                <ChartNoAxesCombined size={16} /> Live analytics
              </span>
            </div>
          </div>
          <div className="art-footer">
            PEOPLE OPERATIONS PLATFORM <span>© 2026 HROne</span>
          </div>
        </div>
        <div className="login-panel">
          <form className="login-card" onSubmit={signIn}>
            <div className="mobile-brand brand">
              <span className="brand-mark">H</span>
              <span>HROne</span>
            </div>
            <span className="eyebrow muted">WELCOME TO HRONE</span>
            <h2>Sign in to your workspace</h2>
            <p className="subtle">Choose a portal to preview the experience.</p>
            <label>Portal</label>
            <div className="role-switch">
              <button
                type="button"
                className={login.role === "admin" ? "selected" : ""}
                onClick={() => setLogin({ ...login, role: "admin" })}
              >
                <ShieldCheck size={17} /> Admin
              </button>
              <button
                type="button"
                className={login.role === "employee" ? "selected" : ""}
                onClick={() => setLogin({ ...login, role: "employee" })}
              >
                <UserRound size={17} /> Employee
              </button>
            </div>
            {login.role === "employee" && (
              <>
                <label>Employee code</label>
                <input
                  value={login.emp_code}
                  onChange={(e) =>
                    setLogin({ ...login, emp_code: e.target.value })
                  }
                  placeholder="e.g. EMP0002"
                  required
                />
              </>
            )}
            <label>Display name</label>
            <input
              value={login.name}
              onChange={(e) => setLogin({ ...login, name: e.target.value })}
              placeholder="Your name"
              required
            />
            <button className="primary full" type="submit">
              <LogIn size={17} /> Open{" "}
              {login.role === "admin" ? "admin dashboard" : "employee portal"}{" "}
              <ArrowUpRight size={16} />
            </button>
            <div className="demo-note">
              <CircleAlert size={16} />
              <span>
                <b>Demo sign-in:</b> this is a UI preview, not secure
                authentication. Connect a verified login service before
                real-world use.
              </span>
            </div>
          </form>
        </div>
      </div>
    );
  const nav = isAdmin
    ? [
        ["Dashboard", LayoutDashboard],
        ["Employees", Users],
        ["Attendance", Clock3],
        ["Analytics", ChartNoAxesCombined],
        ["Reports", FileText],
      ]
    : [
        ["Dashboard", LayoutDashboard],
        ["My Attendance", Clock3],
        ["My Reports", FileText],
      ];
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
        <div className="brand">
          <span className="brand-mark">H</span>
          <span>
            HROne<span className="brand-light"> peopleOS</span>
          </span>
          <button
            className="icon-btn close-nav"
            onClick={() => setMobileNav(false)}
          >
            <X />
          </button>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <div className="nav-list">
          {nav.map(([label, Icon]) => (
            <button
              key={label}
              className={`nav-item ${page === label ? "active" : ""}`}
              onClick={() => {
                setPage(label);
                setMobileNav(false);
                setSearch("");
              }}
            >
              <Icon size={18} />
              <span>{label}</span>
              {label === "Attendance" && (
                <span className="nav-count">{attendance.length}</span>
              )}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="help-card">
            <div className="help-icon">
              <BriefcaseBusiness size={18} />
            </div>
            <b>People first.</b>
            <p>Your team operations, all in one place.</p>
          </div>
          <button
            className="nav-item"
            onClick={() => setNotice("Settings panel is a future extension.")}
          >
            <Settings size={18} /> Settings
          </button>
          <div className="side-user">
            <div className="avatar">
              {(session.name || "U").slice(0, 1).toUpperCase()}
            </div>
            <div className="user-info">
              <b>{session.name}</b>
              <span>{isAdmin ? "Administrator" : session.emp_code}</span>
            </div>
            <button className="icon-btn" title="Sign out" onClick={signOut}>
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <button
            className="icon-btn mobile-menu"
            onClick={() => setMobileNav(true)}
          >
            <Menu />
          </button>
          <div className="breadcrumb">
            Workspace <span>/</span> <b>{page}</b>
          </div>
          <div className="top-actions">
            <div className="month-picker">
              <CalendarDays size={16} />
              <input
                type="month"
                value={monthValue}
                onChange={(e) => setMonthValue(e.target.value)}
              />
            </div>
            <button
              className="icon-btn notification"
              title="Notifications"
              onClick={() => setNotice("You are all caught up.")}
            >
              <Bell size={18} />
              <i />
            </button>
            <div className="top-user">
              <div className="avatar">
                {(session.name || "U").slice(0, 1).toUpperCase()}
              </div>
              <div>
                <b>{session.name}</b>
                <span>{isAdmin ? "Admin portal" : "Employee portal"}</span>
              </div>
              <ChevronDown size={15} />
            </div>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow muted">
                {isAdmin ? "PEOPLE OPERATIONS" : "YOUR WORKSPACE"}
              </div>
              <h1>
                {page === "Dashboard"
                  ? isAdmin
                    ? "Good to see you."
                    : "Your workday, at a glance."
                  : page}
              </h1>
              <p>
                {page === "Dashboard"
                  ? isAdmin
                    ? "Here’s what’s happening across your organisation today."
                    : "Track attendance, review your monthly progress, and stay on top of your workday."
                  : page === "Employees"
                    ? "Manage your people directory and employee details."
                    : page === "Attendance" || page === "My Attendance"
                      ? "Review attendance activity and working hours."
                      : page === "Analytics"
                        ? "Understand attendance patterns across your organisation."
                        : "Download clean, shareable workforce reports."}
              </p>
            </div>
            <div className="heading-actions">
              <button className="secondary" onClick={refresh}>
                <RefreshCw size={16} /> Refresh
              </button>
              {isAdmin && page === "Employees" && (
                <button className="primary" onClick={() => setShowAdd(true)}>
                  <Plus size={17} /> Add employee
                </button>
              )}
            </div>
          </div>
          {error && (
            <div className="alert error">
              <CircleAlert size={17} />
              <span>{error}</span>
              <button onClick={() => setError("")}>Dismiss</button>
            </div>
          )}
          {notice && (
            <div className="alert success">
              <CircleCheck size={17} />
              <span>{notice}</span>
              <button onClick={() => setNotice("")}>Dismiss</button>
            </div>
          )}
          {loading && <div className="loading-line">Refreshing data…</div>}
          {page === "Dashboard" && (
            <>
              <div className="welcome-banner">
                <div>
                  <div className="banner-label">
                    <span className="live-dot" /> LIVE WORKSPACE
                  </div>
                  <h2>
                    {isAdmin
                      ? "People operations, made clearer."
                      : "Make today a good workday."}
                  </h2>
                  <p>
                    {isAdmin
                      ? "A single view of attendance, workforce health, and what needs your attention."
                      : "Your attendance and monthly performance are available whenever you need them."}
                  </p>
                </div>
                <div className="banner-graphic">
                  <div className="graphic-ring ring-one" />
                  <div className="graphic-ring ring-two" />
                  <div className="graphic-center">
                    <ChartNoAxesCombined size={30} />
                  </div>
                </div>
              </div>
              <div className="section-title">
                <div>
                  <h3>
                    {isAdmin ? "Today at a glance" : "Your attendance overview"}
                  </h3>
                  <p>
                    {new Date().toLocaleDateString(undefined, {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </p>
                </div>
                <span className="soft-tag">
                  <span className="live-dot" /> Updated from API
                </span>
              </div>
              <div className="stat-grid">
                {(isAdmin
                  ? [
                      [
                        "Total employees",
                        employees.length,
                        Users,
                        "People in directory",
                        "purple",
                      ],
                      [
                        "Present today",
                        presentToday,
                        CircleCheck,
                        "Present / WFH / on duty",
                        "green",
                      ],
                      [
                        "Late arrivals",
                        lateToday,
                        Clock3,
                        "Needs a quick review",
                        "orange",
                      ],
                      [
                        "Departments",
                        summary.length,
                        BriefcaseBusiness,
                        "Across your organisation",
                        "blue",
                      ],
                    ]
                  : [
                      [
                        "Working days",
                        monthly?.working_days ?? "—",
                        CalendarDays,
                        "This month",
                        "purple",
                      ],
                      [
                        "Present days",
                        monthly?.present_days ?? "—",
                        CircleCheck,
                        "Including half days",
                        "green",
                      ],
                      [
                        "Late arrivals",
                        monthly?.late_count ?? "—",
                        Clock3,
                        "This month",
                        "orange",
                      ],
                      [
                        "Attendance rate",
                        monthly?.attendance_pct == null
                          ? "—"
                          : `${monthly.attendance_pct}%`,
                        ChartNoAxesCombined,
                        "Monthly attendance",
                        "blue",
                      ],
                    ]
                ).map(([title, value, Icon, caption, color]) => (
                  <div className="stat-card" key={title}>
                    <div className={`stat-icon ${color}`}>
                      <Icon size={19} />
                    </div>
                    <div className="stat-caption">
                      {title}
                      <span className="stat-more">•••</span>
                    </div>
                    <div className="stat-value">{value}</div>
                    <div className="stat-foot">
                      <span>{caption}</span>
                    </div>
                  </div>
                ))}
              </div>
              {!isAdmin && (
                <section className="panel quick-actions">
                  <div>
                    <h3>Quick attendance actions</h3>
                    <p>Record your workday using your employee code.</p>
                  </div>
                  <div className="quick-buttons">
                    <button className="primary" onClick={() => punch("in")}>
                      <Clock3 size={16} /> Punch in
                    </button>
                    <button className="secondary" onClick={() => punch("out")}>
                      <CircleCheck size={16} /> Punch out
                    </button>
                  </div>
                </section>
              )}
              <div className="dashboard-grid">
                <section className="panel chart-panel">
                  <div className="panel-head">
                    <div>
                      <h3>Department snapshot</h3>
                      <p>Attendance and team size by department</p>
                    </div>
                    <button
                      className="text-btn"
                      onClick={() => setPage("Analytics")}
                    >
                      View analytics <ArrowUpRight size={15} />
                    </button>
                  </div>
                  {summary.length ? (
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart
                        data={summary}
                        margin={{ top: 10, right: 8, left: -24, bottom: 0 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          vertical={false}
                          stroke="#edf0f5"
                        />
                        <XAxis
                          dataKey="department"
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: "#7b8496", fontSize: 12 }}
                        />
                        <YAxis
                          tickLine={false}
                          axisLine={false}
                          tick={{ fill: "#7b8496", fontSize: 12 }}
                        />
                        <Tooltip />
                        <Bar
                          dataKey="headcount"
                          name="Headcount"
                          fill="#c7d2fe"
                          radius={[6, 6, 0, 0]}
                        />
                        <Bar
                          dataKey="present_days"
                          name="Present days"
                          fill="#5b61e8"
                          radius={[6, 6, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <Empty text="No department summary yet. Add employees and attendance records to see insights." />
                  )}
                </section>
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <h3>Late arrival leaderboard</h3>
                      <p>Monthly late minutes</p>
                    </div>
                    <span className="pill">{monthValue}</span>
                  </div>
                  {leaderboard.length ? (
                    <div className="leader-list">
                      {leaderboard.slice(0, 5).map((r, i) => (
                        <div className="leader-row" key={r.emp_code}>
                          <div className={`rank rank-${i + 1}`}>
                            {r.rank ?? i + 1}
                          </div>
                          <div className="leader-person">
                            <b>{r.name || r.emp_code}</b>
                            <span>
                              {r.department} · {r.emp_code}
                            </span>
                          </div>
                          <div className="leader-minutes">
                            {r.total_late_minutes}
                            <small> min</small>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Empty text="No late arrivals in this month." />
                  )}
                </section>
              </div>
              <section className="panel table-panel">
                <div className="panel-head">
                  <div>
                    <h3>
                      {isAdmin ? "Recent attendance" : "My recent attendance"}
                    </h3>
                    <p>Latest attendance records</p>
                  </div>
                  <button
                    className="text-btn"
                    onClick={() =>
                      setPage(isAdmin ? "Attendance" : "My Attendance")
                    }
                  >
                    View all <ArrowUpRight size={15} />
                  </button>
                </div>
                <AttendanceTable rows={visibleAttendance.slice(0, 6)} />
              </section>
            </>
          )}
          {page === "Employees" && isAdmin && (
            <section className="panel table-panel">
              <Toolbar
                search={search}
                setSearch={setSearch}
                download={downloadCSV}
                placeholder="Search employees…"
              />
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>EMPLOYEE</th>
                      <th>DEPARTMENT</th>
                      <th>EMAIL</th>
                      <th>SHIFT</th>
                      <th>JOINED</th>
                      <th>STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEmployees.map((e) => (
                      <tr key={e.emp_code}>
                        <td>
                          <div className="table-person">
                            <div className="avatar pale">{e.name?.[0]}</div>
                            <div>
                              <b>{e.name}</b>
                              <span>{e.emp_code}</span>
                            </div>
                          </div>
                        </td>
                        <td>{e.department}</td>
                        <td>{e.email}</td>
                        <td>
                          {e.shift_start}–{e.shift_end}
                        </td>
                        <td>{e.joined_on}</td>
                        <td>
                          <span className="status-badge active">Active</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!filteredEmployees.length && (
                  <Empty text="No employees found." />
                )}
              </div>
              <div className="table-footer">
                Showing {filteredEmployees.length} of {employees.length}{" "}
                employees
              </div>
            </section>
          )}
          {(page === "Attendance" || page === "My Attendance") && (
            <section className="panel table-panel">
              <Toolbar
                search={search}
                setSearch={setSearch}
                download={downloadCSV}
                placeholder="Search code, date or status…"
              />
              <AttendanceTable rows={visibleAttendance} />
              <div className="table-footer">
                Showing {visibleAttendance.length} records loaded from the API
              </div>
            </section>
          )}
          {(page === "Analytics" || page === "Reports") && (
            <>
              <div className="stat-grid compact">
                {[
                  ["Departments", summary.length],
                  ["Headcount", summary.reduce((n, x) => n + x.headcount, 0)],
                  [
                    "Late events",
                    summary.reduce((n, x) => n + x.late_count, 0),
                  ],
                  [
                    "Late minutes",
                    summary.reduce((n, x) => n + x.total_late_minutes, 0),
                  ],
                ].map(([t, v], i) => (
                  <div className="mini-stat" key={t}>
                    <span>{t}</span>
                    <b>{v}</b>
                    <small>
                      {i === 0 ? "In current summary" : "Selected month"}
                    </small>
                  </div>
                ))}
              </div>
              <div className="dashboard-grid">
                <section className="panel chart-panel">
                  <div className="panel-head">
                    <div>
                      <h3>Department attendance overview</h3>
                      <p>Summary for {monthValue}</p>
                    </div>
                    <button className="secondary small" onClick={downloadCSV}>
                      <Download size={15} /> Export
                    </button>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>DEPARTMENT</th>
                          <th>HEADCOUNT</th>
                          <th>PRESENT DAYS</th>
                          <th>LATE EVENTS</th>
                          <th>LATE MINUTES</th>
                          <th>AVG HOURS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.map((s) => (
                          <tr key={s.department}>
                            <td>
                              <b>{s.department}</b>
                            </td>
                            <td>{s.headcount}</td>
                            <td>{s.present_days}</td>
                            <td>{s.late_count}</td>
                            <td>{s.total_late_minutes}</td>
                            <td>{fmt(s.avg_work_hours)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
                <section className="panel chart-panel">
                  <div className="panel-head">
                    <div>
                      <h3>Late arrivals</h3>
                      <p>Leaderboard for {monthValue}</p>
                    </div>
                  </div>
                  {leaderboard.length ? (
                    <ResponsiveContainer width="100%" height={260}>
                      <AreaChart data={leaderboard.slice(0, 8)}>
                        <CartesianGrid
                          strokeDasharray="3 3"
                          vertical={false}
                          stroke="#edf0f5"
                        />
                        <XAxis
                          dataKey="emp_code"
                          tickLine={false}
                          axisLine={false}
                          tick={{ fontSize: 11 }}
                        />
                        <YAxis
                          tickLine={false}
                          axisLine={false}
                          tick={{ fontSize: 11 }}
                        />
                        <Tooltip />
                        <Area
                          type="monotone"
                          dataKey="total_late_minutes"
                          stroke="#6268e9"
                          fill="#e5e7ff"
                          strokeWidth={2}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <Empty text="No late arrival data." />
                  )}
                </section>
              </div>
              <section className="panel report-note">
                <div className="report-icon">
                  <FileText />
                </div>
                <div>
                  <h3>Export a working report</h3>
                  <p>
                    Download the current employee or attendance table as CSV
                    using the export control on its page. For this dashboard,
                    use the department summary table above.
                  </p>
                </div>
                <button
                  className="secondary"
                  onClick={() => {
                    setPage(isAdmin ? "Employees" : "My Attendance");
                  }}
                >
                  Open records <ArrowUpRight size={16} />
                </button>
              </section>
            </>
          )}
        </div>
        <footer className="footer">
          <span>
            HROne peopleOS <b>•</b> Attendance & workforce insights
          </span>
          <span>Connected to your FastAPI workspace</span>
        </footer>
      </main>
      {showAdd && (
        <div className="modal-backdrop" onClick={() => setShowAdd(false)}>
          <form
            className="modal"
            onSubmit={addEmployee}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <div>
                <span className="eyebrow muted">PEOPLE DIRECTORY</span>
                <h2>Add employee</h2>
              </div>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setShowAdd(false)}
              >
                <X />
              </button>
            </div>
            <div className="form-grid">
              {[
                ["emp_code", "Employee code", "EMP0003"],
                ["name", "Full name", "Employee name"],
                ["email", "Work email", "name@company.com"],
                ["department", "Department", "Engineering"],
                ["shift_start", "Shift starts", "09:30"],
                ["shift_end", "Shift ends", "18:30"],
                ["joined_on", "Joining date", today],
              ].map(([key, label, placeholder]) => (
                <label key={key}>
                  {label}
                  <input
                    required
                    value={form[key]}
                    placeholder={placeholder}
                    type={
                      key === "joined_on"
                        ? "date"
                        : key.startsWith("shift_")
                          ? "text"
                          : "text"
                    }
                    onChange={(e) =>
                      setForm({ ...form, [key]: e.target.value })
                    }
                  />
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setShowAdd(false)}
              >
                Cancel
              </button>
              <button type="submit" className="primary">
                <Plus size={16} /> Create employee
              </button>
            </div>
            <p className="modal-hint">
              Employee codes must follow the API format, for example EMP0003.
            </p>
          </form>
        </div>
      )}
    </div>
  );
}
function Empty({ text }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <FileText size={20} />
      </div>
      <p>{text}</p>
    </div>
  );
}
function Toolbar({ search, setSearch, download, placeholder }) {
  return (
    <div className="toolbar">
      <div className="search-box">
        <Search size={17} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={placeholder}
        />
      </div>
      <button className="secondary" onClick={download}>
        <Download size={16} /> Export CSV
      </button>
    </div>
  );
}
function AttendanceTable({ rows }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>EMPLOYEE</th>
            <th>DATE</th>
            <th>STATUS</th>
            <th>PUNCH IN</th>
            <th>PUNCH OUT</th>
            <th>WORK HOURS</th>
            <th>LATE (MIN)</th>
            <th>OVERTIME</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.emp_code}-${r.date}-${i}`}>
              <td>
                <div className="table-person">
                  <div className="avatar pale">
                    {r.emp_code?.slice(-1) || "E"}
                  </div>
                  <div>
                    <b>{r.emp_code}</b>
                    <span>Attendance record</span>
                  </div>
                </div>
              </td>
              <td>{r.date}</td>
              <td>
                <span
                  className={`status-badge ${["PRESENT", "WFH", "ON_DUTY"].includes(r.status) ? "active" : r.status === "LEAVE" ? "leave" : "absent"}`}
                >
                  {r.status}
                </span>
              </td>
              <td>
                {r.punch_in
                  ? new Date(r.punch_in).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "—"}
              </td>
              <td>
                {r.punch_out
                  ? new Date(r.punch_out).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "—"}
              </td>
              <td>{fmt(r.work_hours)}</td>
              <td>
                <span className={(r.late_minutes || 0) > 0 ? "late-value" : ""}>
                  {r.late_minutes || 0}
                </span>
              </td>
              <td>{r.overtime_minutes || 0} min</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <Empty text="No attendance records match this view." />}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
