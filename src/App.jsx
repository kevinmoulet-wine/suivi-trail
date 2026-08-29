import React, { useState, useEffect, useMemo, useRef } from "react";
import Papa from "papaparse";
import storage from "./storage.js";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend
} from "recharts";
import {
  Upload, Mountain, Flag, Plus, Trash2, X, ChevronDown, ChevronUp,
  TrendingUp, Activity, Gauge, CalendarDays, Settings2, Target, BookOpen, Home as HomeIcon,
  Database, User, Check, History
} from "lucide-react";

// ---------- Design tokens (placeholder — design pass later) ----------
const C = {
  bg: "#11150F", surface: "#1B211A", surfaceHi: "#232B21", border: "#2E362B",
  text: "#EDEBE2", muted: "#8E9986", blaze: "#E2532B", pine: "#5C8A6E",
  gold: "#C9A227", brick: "#B85450",
};
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };

// ---------- Generic helpers ----------
function paceToMin(p) {
  if (!p || !p.includes(":")) return null;
  const [m, s] = p.split(":").map(Number);
  return Number.isNaN(m) || Number.isNaN(s) ? null : +(m + s / 60).toFixed(2);
}
function fmtDateFR(s) {
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}
function daysUntil(s) { return s ? Math.ceil((new Date(s) - new Date()) / 86400000) : null; }
function addDays(d, n) { const dt = new Date(d); dt.setDate(dt.getDate() + n); return dt; }
function isoDate(d) { return d.toISOString().slice(0, 10); }
function startOfWeekMonday(d) { const dt = new Date(d); const day = (dt.getDay() + 6) % 7; dt.setDate(dt.getDate() - day); dt.setHours(0, 0, 0, 0); return dt; }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function timeToDecimal(t) {
  if (!t) return 0;
  const [h, m] = t.split(":").map(Number);
  return h + (m || 0) / 60;
}
const DAY_ORDER = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"];
const GOAL_TAG_COLORS = [C.blaze, C.pine, C.gold, C.brick];
function goalColor(goals, goalId) {
  const idx = goals.findIndex(g => g.id === goalId);
  return GOAL_TAG_COLORS[idx % GOAL_TAG_COLORS.length] || C.muted;
}

// ---------- Plan generation ----------
function defaultWindowWeeks(distance) {
  if (distance <= 55) return 8;
  if (distance <= 100) return 12;
  return 16;
}
function phaseSplit(totalWeeks) {
  const taper = 2;
  const build = Math.max(totalWeeks - taper, 3);
  const base = Math.round(build * 0.4);
  const dev = Math.round(build * 0.35);
  const pic = Math.max(build - base - dev, 1);
  return { base, dev, pic, taper };
}
function buildWeekSessions(goal, phase, weekStart) {
  const sessions = goal.program?.sessions || [];
  if (!sessions.length) return [];
  return sessions.map(s => ({
    date: isoDate(addDays(weekStart, DAY_ORDER.indexOf(s.day))),
    type: s.type || "Séance",
    estKm: +s.km || 0,
    estDplus: +s.dplus || 0,
    durationH: s.start && s.end ? +(timeToDecimal(s.end) - timeToDecimal(s.start)).toFixed(1) : null,
    start: s.start, end: s.end,
  }));
}
function buildLeafPlan(goal) {
  const raceDate = new Date(goal.date);
  const windowWeeks = goal.windowWeeks || defaultWindowWeeks(goal.distance || 50);
  const windowStart = startOfWeekMonday(addDays(raceDate, -windowWeeks * 7));
  const { base, dev, pic, taper } = phaseSplit(windowWeeks);
  const seq = [...Array(base).fill("Base"), ...Array(dev).fill("Développement"), ...Array(pic).fill("Pic"), ...Array(taper).fill("Affûtage")];
  let cursor = windowStart;
  const weeks = seq.map(phase => {
    const w = { start: isoDate(cursor), end: isoDate(addDays(cursor, 6)), phase, sessions: buildWeekSessions(goal, phase, cursor) };
    cursor = addDays(cursor, 7);
    return w;
  });
  return { weeks, windowStart: isoDate(windowStart) };
}
function buildPlanWithChild(parent, child) {
  const childPlan = buildLeafPlan(child);
  const childWeeks = childPlan.weeks.map(w => ({ ...w, phase: `${w.phase} (partagé · ${child.nom})` }));
  const raceWeekStart = startOfWeekMonday(new Date(child.date));
  let cursor = addDays(raceWeekStart, 7);
  const parentRaceDate = new Date(parent.date);
  const remainingWeeksCount = Math.max(Math.round((parentRaceDate - cursor) / (7 * 86400000)), 4);
  const { dev, pic, taper } = phaseSplit(remainingWeeksCount);
  const seq2 = [...Array(Math.max(remainingWeeksCount - pic - taper, 1)).fill("Développement"), ...Array(pic).fill("Pic"), ...Array(taper).fill("Affûtage")];
  const recovWeek = { start: isoDate(cursor), end: isoDate(addDays(cursor, 6)), phase: "Récupération", sessions: buildWeekSessions(parent, "Récupération", cursor) };
  cursor = addDays(cursor, 7);
  const secondBlock = seq2.map(phase => {
    const w = { start: isoDate(cursor), end: isoDate(addDays(cursor, 6)), phase, sessions: buildWeekSessions(parent, phase, cursor) };
    cursor = addDays(cursor, 7);
    return w;
  });
  return { weeks: [...childWeeks, recovWeek, ...secondBlock], windowStart: childPlan.windowStart, milestone: { nom: child.nom, date: child.date } };
}
function buildPlan(goal, goals) {
  const child = goals.find(g => g.isPrepFor === goal.id);
  if (child) return buildPlanWithChild(goal, child);
  return buildLeafPlan(goal);
}

// Poids relatifs par phase, utilisés pour répartir un total km / D+ semaine par semaine
function phaseWeight(phase, metric) {
  const key = phase.split(" (")[0];
  const table = {
    km: { "Base": 0.7, "Développement": 0.9, "Pic": 1.15, "Affûtage": 0.4, "Récupération": 0.3 },
    dplus: { "Base": 0.5, "Développement": 0.9, "Pic": 1.3, "Affûtage": 0.3, "Récupération": 0.2 },
  };
  return table[metric][key] ?? 0.7;
}
// Distribue un objectif total (km ou D+) sur les semaines du plan, proportionnellement au poids de chaque phase
function distributeWeeklyTargets(weeks, totalKm, totalDplus) {
  const kmW = weeks.map(w => phaseWeight(w.phase, "km"));
  const dplusW = weeks.map(w => phaseWeight(w.phase, "dplus"));
  const kmSum = kmW.reduce((a, b) => a + b, 0) || 1;
  const dplusSum = dplusW.reduce((a, b) => a + b, 0) || 1;
  return weeks.map((w, i) => ({
    ...w,
    targetKm: +(totalKm * kmW[i] / kmSum).toFixed(1),
    targetDplus: Math.round(totalDplus * dplusW[i] / dplusSum),
  }));
}
// Finalise un plan : suggestion de volume total basée sur la distance/D+ de la course (ajustable),
// répartition semaine par semaine, puis comparaison du programme récurrent saisi face au besoin par phase.
function finalizePlan(goal, rawPlan) {
  const peakWeeklyKm = (goal.distance || 50) * 0.6;
  const avgWeeklyKm = peakWeeklyKm * 0.7;
  const suggestedKm = Math.round(rawPlan.weeks.length * avgWeeklyKm) || 1;
  const suggestedDplus = Math.round((goal.dplus || 0) * 2.5) || 1;
  const totalKm = goal.targetKm || suggestedKm;
  const totalDplus = goal.targetDplus || suggestedDplus;
  const weeks = distributeWeeklyTargets(rawPlan.weeks, totalKm, totalDplus);

  const progSessions = (goal.program?.sessions || []).filter(s => !(s.type || "").includes("Repos"));
  const templateKm = +progSessions.reduce((s, x) => s + (+x.km || 0), 0).toFixed(1);
  const templateDplus = Math.round(progSessions.reduce((s, x) => s + (+x.dplus || 0), 0));

  const phaseOrder = [];
  weeks.forEach(w => { const key = w.phase.split(" (")[0]; if (!phaseOrder.includes(key)) phaseOrder.push(key); });
  const phaseComparison = phaseOrder.map(key => {
    const wks = weeks.filter(w => w.phase.split(" (")[0] === key);
    const avgKm = +(wks.reduce((s, w) => s + w.targetKm, 0) / wks.length).toFixed(1);
    const avgDplus = Math.round(wks.reduce((s, w) => s + w.targetDplus, 0) / wks.length);
    const deltaKm = +(templateKm - avgKm).toFixed(1);
    const deltaDplus = templateDplus - avgDplus;
    const verdict = Math.abs(deltaKm) <= avgKm * 0.1 ? "ok" : deltaKm < 0 ? "insuffisant" : "excessif";
    return { phase: key, weeks: wks.length, avgKm, avgDplus, deltaKm, deltaDplus, verdict };
  });

  return { ...rawPlan, weeks, totalKm, totalDplus, suggestedKm, suggestedDplus, templateKm, templateDplus, phaseComparison };
}

// ---------- Matching & scoring ----------
function findActivity(dateStr, activities) {
  const t = new Date(dateStr).getTime();
  return activities.find(a => Math.abs(new Date(a.date).getTime() - t) <= 86400000);
}
function ratio(a, b) { return b <= 0 ? 1 : Math.min(a / b, 1); }

function getLatestMetric(target, activities) {
  if (target.type === "vo2max") {
    const pts = activities.filter(a => a.vo2max).sort((a, b) => new Date(b.date) - new Date(a.date));
    return pts[0]?.vo2max ?? target.start;
  }
  if (target.type === "sortie_longue") {
    return Math.max(target.start, ...activities.map(a => a.distance_km || 0), 0);
  }
  if (target.type === "allure") {
    const pts = activities.filter(a => a.type === "running" && a.allure_min).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
    return pts.length ? Math.min(...pts.map(a => a.allure_min)) : target.start;
  }
  return target.currentOverride ?? target.start;
}
function nominalProgress(target, activities) {
  const current = getLatestMetric(target, activities);
  const direction = target.direction || (target.type === "allure" ? "lower" : "higher");
  const progress = direction === "lower"
    ? clamp01((target.start - current) / (target.start - target.target || -1))
    : clamp01((current - target.start) / (target.target - target.start || 1));
  return { current, progress };
}

function computeGoalScore(goal, plan, activities, today) {
  const weeks = plan.weeks;
  if (!weeks.length || today < new Date(weeks[0].start)) {
    return { global: null, breakdown: {}, notStarted: true };
  }
  const idx = weeks.findIndex(w => today >= new Date(w.start) && today <= new Date(w.end));
  const lastIdx = idx === -1 ? weeks.length - 1 : idx;

  let idealKm = 0, idealDplus = 0;
  weeks.forEach((w, i) => {
    if (i < lastIdx) { idealKm += w.targetKm; idealDplus += w.targetDplus; }
    else if (i === lastIdx) {
      const frac = idx === -1 ? 1 : Math.min((Math.floor((today - new Date(w.start)) / 86400000) + 1) / 7, 1);
      idealKm += w.targetKm * frac;
      idealDplus += w.targetDplus * frac;
    }
  });
  if (idealKm <= 0) return { global: null, breakdown: {}, notStarted: true };

  const windowStart = new Date(plan.windowStart);
  const realActs = activities.filter(a => { const d = new Date(a.date); return d >= windowStart && d <= today; });
  const realKm = realActs.reduce((s, a) => s + (a.distance_km || 0), 0);
  const realDplus = realActs.reduce((s, a) => s + (a.d_plus || 0), 0);

  const dplusScore = clamp01(idealDplus > 0 ? realDplus / idealDplus : 0);
  const volScore = clamp01(idealKm > 0 ? realKm / idealKm : 0);

  const longThreshold = (goal.distance || 50) * 0.55;
  const allSessions = weeks.flatMap(w => w.sessions);
  const pastSessions = allSessions.filter(s => new Date(s.date) <= today);
  const plannedLong = pastSessions.filter(s => s.type === "Sortie longue").length;
  const realLong = realActs.filter(a => (a.distance_km || 0) >= longThreshold).length;
  const longScore = plannedLong > 0 ? clamp01(realLong / plannedLong) : (realLong > 0 ? 1 : 0.7);

  const nonRestPast = pastSessions.filter(s => !s.type.includes("Repos"));
  const realizedCount = nonRestPast.filter(s => findActivity(s.date, activities)).length;
  const regScore = nonRestPast.length ? realizedCount / nonRestPast.length : 1;

  let tendScore = 0.6;
  const vo2Target = (goal.nominalTargets || []).find(t => t.type === "vo2max");
  const vo2Points = activities.filter(a => a.vo2max && new Date(a.date) >= windowStart).sort((a, b) => new Date(a.date) - new Date(b.date));
  if (vo2Target && vo2Points.length >= 2) {
    const weeksTotal = Math.max((new Date(goal.date) - windowStart) / (7 * 86400000), 1);
    const weeksElapsed = Math.max((today - windowStart) / (7 * 86400000), 0.5);
    const requiredRate = (vo2Target.target - vo2Target.start) / weeksTotal;
    const actualRate = (vo2Points[vo2Points.length - 1].vo2max - vo2Target.start) / weeksElapsed;
    tendScore = requiredRate === 0 ? 1 : clamp01(actualRate / requiredRate);
  } else if (vo2Points.length >= 2) {
    const delta = vo2Points[vo2Points.length - 1].vo2max - vo2Points[0].vo2max;
    tendScore = delta > 0 ? 0.9 : delta === 0 ? 0.6 : 0.3;
  }

  const global = 0.30 * dplusScore + 0.20 * volScore + 0.20 * longScore + 0.15 * regScore + 0.15 * tendScore;
  return {
    global: Math.round(global * 100),
    breakdown: {
      "D+ (30%)": Math.round(dplusScore * 100),
      "Volume (20%)": Math.round(volScore * 100),
      "Sorties longues (20%)": Math.round(longScore * 100),
      "Régularité (15%)": Math.round(regScore * 100),
      "Tendance VO2max (15%)": Math.round(tendScore * 100),
    },
    cumulative: { realKm: +realKm.toFixed(1), idealKm: +idealKm.toFixed(1), realDplus: Math.round(realDplus), idealDplus: Math.round(idealDplus) },
  };
}

// ---------- UI atoms ----------
function Card({ children, style }) { return <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, ...style }}>{children}</div>; }
function SectionLabel({ icon: Icon, children }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, color: C.muted }}>
    {Icon && <Icon size={14} />}
    <span style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700 }}>{children}</span>
  </div>;
}
function ProgressBar({ pct, color = C.blaze }) {
  return <div style={{ background: C.surfaceHi, borderRadius: 6, height: 8, overflow: "hidden" }}>
    <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color, height: "100%" }} />
  </div>;
}
function inputStyle() { return { flex: 1, background: C.surfaceHi, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "7px 9px", fontSize: 13 }; }
function btnStyle(primary) { return { background: primary ? C.blaze : "transparent", color: primary ? "#1A0D08" : C.muted, border: primary ? "none" : `1px solid ${C.border}`, borderRadius: 7, padding: "7px 12px", fontWeight: 700, fontSize: 12.5, cursor: "pointer" }; }

const CHART_TEXT = { fill: C.muted, fontSize: 11 };
function tooltipStyle() { return { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, color: C.text }; }

// ---------- App ----------
export default function TrailTracker() {
  const [activities, setActivities] = useState([]);
  const [goals, setGoals] = useState([]);
  const [journal, setJournal] = useState({});
  const [profile, setProfile] = useState({});
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("home");
  const [courseTab, setCourseTab] = useState("suivi");
  const [importMode, setImportMode] = useState("file");
  const [pasteText, setPasteText] = useState("");
  const [error, setError] = useState("");
  const fileInput = useRef(null);
  const today = new Date();
  const todayIso = isoDate(today);

  useEffect(() => {
    (async () => {
      try { const a = await storage.get("activities"); if (a?.value) setActivities(JSON.parse(a.value)); } catch (e) {}
      try { const g = await storage.get("goals"); if (g?.value) setGoals(JSON.parse(g.value)); } catch (e) {}
      try { const j = await storage.get("journal"); if (j?.value) setJournal(JSON.parse(j.value)); } catch (e) {}
      try { const p = await storage.get("profile"); if (p?.value) setProfile(JSON.parse(p.value)); } catch (e) {}
      setLoading(false);
    })();
  }, []);

  async function persistActivities(rows) { setActivities(rows); try { await storage.set("activities", JSON.stringify(rows)); } catch (e) { console.error(e); } }
  async function persistGoals(list) { setGoals(list); try { await storage.set("goals", JSON.stringify(list)); } catch (e) { console.error(e); } }
  async function persistJournal(obj) { setJournal(obj); try { await storage.set("journal", JSON.stringify(obj)); } catch (e) { console.error(e); } }
  async function persistProfile(obj) { setProfile(obj); try { await storage.set("profile", JSON.stringify(obj)); } catch (e) { console.error(e); } }

  function handleParsed(rows) {
    const clean = rows.filter(r => r.date).map(r => ({
      date: r.date, nom: r.nom, type: r.type,
      distance_km: parseFloat(r.distance_km) || 0,
      duree: r.duree || null,
      allure: r.allure_min_par_km, allure_min: paceToMin(r.allure_min_par_km),
      d_plus: parseFloat(r.d_plus_m) || 0,
      d_moins: parseFloat(r.d_moins_m) || null,
      fc_moy: parseFloat(r.fc_moyenne) || null,
      fc_max: parseFloat(r.fc_max) || null,
      vitesse_moy: parseFloat(r.vitesse_moy_kmh) || null,
      vitesse_max: parseFloat(r.vitesse_max_kmh) || null,
      calories: parseFloat(r.calories) || null,
      vo2max: parseFloat(r.vo2max_estime) || null,
      cadence: parseFloat(r.cadence_moyenne) || null,
      puissance: parseFloat(r.puissance_moyenne_w) || null,
      temperature: parseFloat(r.temperature_moy_C) || null,
      teAerobie: parseFloat(r.training_effect_aerobie) || null,
      teAnaerobie: parseFloat(r.training_effect_anaerobie) || null,
    })).sort((a, b) => new Date(a.date) - new Date(b.date));
    const byDate = new Map(activities.map(a => [a.date + a.nom, a]));
    clean.forEach(c => byDate.set(c.date + c.nom, c));
    const merged = [...byDate.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
    persistActivities(merged);
    setError("");
  }
  function onFile(e) { const f = e.target.files?.[0]; if (!f) return; Papa.parse(f, { header: true, skipEmptyLines: true, complete: r => handleParsed(r.data) }); }
  function onPasteImport() { if (!pasteText.trim()) { setError("Colle d'abord le contenu du CSV."); return; } Papa.parse(pasteText, { header: true, skipEmptyLines: true, complete: r => handleParsed(r.data) }); }

  function addGoal(g) { const withId = { ...g, id: Date.now().toString(), program: { sessions: [], notes: "" }, nominalTargets: [] }; persistGoals([...goals, withId]); setView(withId.id); setCourseTab("programme"); }
  function removeGoal(id) { persistGoals(goals.filter(g => g.id !== id)); }
  function updateGoal(id, updater) { persistGoals(goals.map(g => g.id === id ? updater(g) : g)); }

  const plans = useMemo(() => {
    const map = {};
    goals.forEach(g => { map[g.id] = finalizePlan(g, buildPlan(g, goals)); });
    return map;
  }, [goals]);

  const scores = useMemo(() => {
    const map = {};
    goals.forEach(g => { map[g.id] = computeGoalScore(g, plans[g.id], activities, today); });
    return map;
  }, [goals, plans, activities]);

  if (loading) return <div style={{ background: C.bg, color: C.muted, minHeight: 400, display: "flex", alignItems: "center", justifyContent: "center" }}>Chargement…</div>;

  const importSection = (
    <Card style={{ marginBottom: 20 }}>
      <SectionLabel icon={Upload}>Importer des données</SectionLabel>
      <div className="flex gap-2 mb-3">
        <button onClick={() => setImportMode("file")} style={btnStyle(importMode === "file")}>Fichier</button>
        <button onClick={() => setImportMode("paste")} style={btnStyle(importMode === "paste")}>Coller le CSV</button>
      </div>
      {importMode === "file" ? (
        <div>
          <input ref={fileInput} type="file" accept=".csv" onChange={onFile} style={{ display: "none" }} />
          <button onClick={() => fileInput.current?.click()} style={btnStyle(true)}>Choisir garmin_export.csv</button>
        </div>
      ) : (
        <div>
          <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} placeholder="Colle ici le contenu du CSV"
            style={{ width: "100%", height: 90, background: C.surfaceHi, color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: 10, fontSize: 12, ...mono }} />
          <button onClick={onPasteImport} style={{ ...btnStyle(true), marginTop: 8 }}>Importer</button>
        </div>
      )}
      {error && <p style={{ color: C.brick, fontSize: 12, marginTop: 8 }}>{error}</p>}
      {activities.length > 0 && <p style={{ color: C.pine, fontSize: 12, marginTop: 10 }}>{activities.length} activités · dernière le {fmtDateFR(activities[activities.length - 1]?.date)}</p>}
    </Card>
  );

  const currentGoal = ["home", "add", "data", "history"].includes(view) ? null : goals.find(g => g.id === view);

  return (
    <div style={{ background: C.bg, color: C.text, minHeight: "100vh", fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div style={{ borderBottom: `1px solid ${C.border}`, padding: "24px 20px 18px" }}>
        <div className="flex items-center gap-2" style={{ color: C.blaze }}>
          <Mountain size={18} /><span style={{ fontSize: 12, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 700 }}>Carnet de trail</span>
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>Objectifs & préparation</h1>
        <div className="flex gap-2" style={{ marginTop: 14, flexWrap: "wrap" }}>
          <button onClick={() => setView("home")} style={btnStyle(view === "home")} className="flex items-center gap-1"><HomeIcon size={13} /> Home</button>
          <button onClick={() => setView("history")} style={btnStyle(view === "history")} className="flex items-center gap-1"><History size={13} /> Historique</button>
          <button onClick={() => setView("data")} style={btnStyle(view === "data")} className="flex items-center gap-1"><Database size={13} /> Mes données</button>
          {goals.map(g => (
            <button key={g.id} onClick={() => { setView(g.id); setCourseTab("suivi"); }} style={btnStyle(view === g.id)} className="flex items-center gap-1">
              <Flag size={13} /> {g.nom}
            </button>
          ))}
          <button onClick={() => setView("add")} style={btnStyle(view === "add")} title="Ajouter une course"><Plus size={13} /></button>
        </div>
      </div>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "20px" }}>
        {view === "home" && (
          <>
            <LastActivityCard activities={activities} onViewAll={() => setView("history")} />
            <CourseOverviewList goals={goals} scores={scores} onSelect={id => { setView(id); setCourseTab("suivi"); }} />
            <MonthCalendar goals={goals} />
            <WeekCalendar goals={goals} plans={plans} todayIso={todayIso} journal={journal}
              onSaveNote={(date, score, note) => persistJournal({ ...journal, [date]: { score, note } })} />
          </>
        )}

        {view === "history" && (
          <>
            <SectionLabel icon={History}>Historique des sorties</SectionLabel>
            <ActivityHistoryList activities={activities} />
          </>
        )}

        {view === "data" && (
          <>
            <PersonalDataForm profile={profile} onUpdate={persistProfile} />
            {importSection}
          </>
        )}

        {view === "add" && (
          <GoalForm goals={goals} onCancel={() => setView("home")} onSave={addGoal} />
        )}

        {currentGoal && (
          <>
            <div className="flex gap-2 mb-4">
              {[["suivi", "Suivi"], ["programme", "Programme"], ["nutrition", "Nutrition"]].map(([k, label]) => (
                <button key={k} onClick={() => setCourseTab(k)} style={btnStyle(courseTab === k)}>{label}</button>
              ))}
            </div>

            {courseTab === "suivi" && (
              <CourseDashboards goal={currentGoal} plan={plans[currentGoal.id]} score={scores[currentGoal.id]} activities={activities} today={today} todayIso={todayIso} showTitle={false} />
            )}

            {courseTab === "programme" && (
              <GoalDetail goal={currentGoal} goals={goals} plan={plans[currentGoal.id]} score={scores[currentGoal.id]} activities={activities}
                onUpdate={updater => updateGoal(currentGoal.id, updater)} onRemove={() => { removeGoal(currentGoal.id); setView("home"); }} today={today} />
            )}

            {courseTab === "nutrition" && (
              <Card>
                <SectionLabel icon={Activity}>Nutrition</SectionLabel>
                <p style={{ color: C.muted, fontSize: 13 }}>À venir — cette section sera développée prochainement (plan nutritionnel, ravitaillement course, etc.).</p>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------- Course dashboards (résumé + 3 dashboards de suivi pour une course donnée) ----------
function CourseDashboards({ goal, plan, score, activities, today, todayIso, showTitle = true }) {
  const currentWeek = useMemo(() => {
    if (!plan) return null;
    return plan.weeks.find(w => w.start <= todayIso && todayIso <= w.end) || null;
  }, [plan, todayIso]);

  const currentWeekReal = useMemo(() => {
    if (!currentWeek) return { km: 0, dplus: 0 };
    const acts = activities.filter(a => a.date >= currentWeek.start && a.date <= currentWeek.end);
    return {
      km: +acts.reduce((s, a) => s + (a.distance_km || 0), 0).toFixed(1),
      dplus: Math.round(acts.reduce((s, a) => s + (a.d_plus || 0), 0)),
    };
  }, [currentWeek, activities]);

  const nextSession = useMemo(() => {
    if (!plan) return null;
    const startIdx = currentWeek ? plan.weeks.indexOf(currentWeek) : plan.weeks.findIndex(w => w.start >= todayIso);
    const searchWeeks = startIdx === -1 ? [] : plan.weeks.slice(startIdx);
    for (const w of searchWeeks) {
      const candidate = w.sessions
        .filter(s => !(s.type || "").includes("Repos"))
        .filter(s => s.date >= todayIso)
        .sort((a, b) => new Date(a.date) - new Date(b.date))[0];
      if (candidate) return candidate;
    }
    return null;
  }, [plan, currentWeek, todayIso]);

  // Dashboard 1 — cumul km réel vs cible (cible = plan.weeks[i].targetKm cumulé, la même cible totale
  // ajustable qu'utilisent la Comparaison et le Plan de l'onglet Programme)
  const cumulKmSeries = useMemo(() => {
    if (!plan) return [];
    let cibleCum = 0, reelCum = 0;
    return plan.weeks.map(w => {
      cibleCum += w.targetKm;
      const started = w.start <= todayIso;
      if (started) {
        const acts = activities.filter(a => a.date >= w.start && a.date <= w.end);
        reelCum += acts.reduce((s, a) => s + (a.distance_km || 0), 0);
      }
      return { date: w.end, cible: +cibleCum.toFixed(1), reel: started ? +reelCum.toFixed(1) : null };
    });
  }, [plan, activities, todayIso]);

  // Dashboard 2 — VO2max réelle vs prévisionnelle. La prévisionnelle suit la trajectoire linéaire
  // start → target de la cible nominale vo2max, mais la portion passée est pondérée par l'adhérence
  // réelle au programme (séances réalisées / séances prévues à ce jour) ; la portion future prolonge
  // depuis ce point ajusté jusqu'à la cible à la date de course.
  const vo2ProjectionSeries = useMemo(() => {
    if (!goal || !plan) return { points: [], hasTarget: false };
    const vo2Target = (goal.nominalTargets || []).find(t => t.type === "vo2max");
    const windowStart = plan.windowStart;
    const raceDate = goal.date;
    const realPoints = activities.filter(a => a.vo2max && a.date >= windowStart && a.date <= raceDate);
    if (!vo2Target) {
      return { points: realPoints.map(a => ({ date: a.date, reel: a.vo2max, previsionnel: null })), hasTarget: false };
    }
    const spanMs = new Date(raceDate) - new Date(windowStart) || 1;
    const fractionOf = d => clamp01((new Date(d) - new Date(windowStart)) / spanMs);
    const todayFraction = Math.min(clamp01(fractionOf(todayIso)), 0.999);

    const allSessions = plan.weeks.flatMap(w => w.sessions);
    const pastSessions = allSessions.filter(s => s.date <= todayIso && !(s.type || "").includes("Repos"));
    const realizedCount = pastSessions.filter(s => findActivity(s.date, activities)).length;
    const adherence = pastSessions.length ? realizedCount / pastSessions.length : 1;

    const { start, target } = vo2Target;
    function projectedValue(fraction) {
      if (fraction <= todayFraction) return +(start + (target - start) * fraction * adherence).toFixed(1);
      const todayVal = start + (target - start) * todayFraction * adherence;
      return +(todayVal + (target - todayVal) * ((fraction - todayFraction) / (1 - todayFraction))).toFixed(1);
    }

    const dates = Array.from(new Set([...realPoints.map(a => a.date), ...plan.weeks.map(w => w.end)])).sort();
    const points = dates.map(d => ({
      date: d,
      reel: realPoints.find(a => a.date === d)?.vo2max ?? null,
      previsionnel: projectedValue(fractionOf(d)),
    }));
    return { points, hasTarget: true, adherence };
  }, [goal, plan, activities, todayIso]);

  // Dashboard 3 — volume hebdo réalisé vs programme prévu (semaines déjà entamées uniquement)
  const weeklyVsPlanSeries = useMemo(() => {
    if (!plan) return [];
    return plan.weeks
      .filter(w => w.start <= todayIso)
      .map(w => {
        const acts = activities.filter(a => a.date >= w.start && a.date <= w.end);
        const reel = +acts.reduce((s, a) => s + (a.distance_km || 0), 0).toFixed(1);
        return { semaine: w.start, reel, prevu: w.targetKm };
      });
  }, [plan, activities, todayIso]);

  if (!goal || !plan) return null;

  return (
    <>
      <Card style={{ marginBottom: 20 }}>
        {showTitle && <SectionLabel icon={Flag}>{goal.nom}</SectionLabel>}
        <div className="flex items-center justify-between">
          <div style={{ ...mono, fontSize: 32, fontWeight: 800, color: C.gold }}>J-{daysUntil(goal.date)}</div>
          <div style={{ ...mono, fontSize: 22, fontWeight: 700, color: C.text }}>
            {score?.notStarted || score?.global == null ? "—" : `${score.global}%`}
          </div>
        </div>
        {!(score?.notStarted || score?.global == null) && <ProgressBar pct={score.global} />}
        <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 12, paddingTop: 12 }}>
          <div className="flex items-center justify-between" style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>
            <span>Cette semaine</span>
          </div>
          {currentWeek ? (
            <p style={{ ...mono, fontSize: 15, color: C.text }}>
              {currentWeekReal.km}/{currentWeek.targetKm}km · {currentWeekReal.dplus}/{currentWeek.targetDplus}m D+
            </p>
          ) : (
            <p style={{ color: C.muted, fontSize: 12 }}>Hors fenêtre de préparation.</p>
          )}
        </div>
        <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 12, paddingTop: 12 }}>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Prochaine séance</div>
          {nextSession ? (
            <p style={{ fontSize: 13, color: C.text }}>
              {fmtDateFR(nextSession.date)} · {nextSession.type} · {nextSession.estKm}km{nextSession.estDplus ? ` · ${nextSession.estDplus}m D+` : ""}
            </p>
          ) : (
            <p style={{ color: C.muted, fontSize: 12 }}>Aucune séance à venir dans le programme.</p>
          )}
        </div>
      </Card>

      {cumulKmSeries.length > 1 && (
        <Card style={{ marginBottom: 16 }}>
          <SectionLabel icon={Target}>Cumul km — réel vs cible</SectionLabel>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={cumulKmSeries}>
              <CartesianGrid stroke={C.border} vertical={false} />
              <XAxis dataKey="date" tick={CHART_TEXT} tickFormatter={fmtDateFR} minTickGap={30} />
              <YAxis tick={CHART_TEXT} width={36} />
              <Tooltip contentStyle={tooltipStyle()} labelFormatter={fmtDateFR} />
              <Legend wrapperStyle={{ fontSize: 11, color: C.muted }} />
              <Line type="monotone" dataKey="cible" name="Cible cumulée (km)" stroke={C.muted} strokeWidth={2} strokeDasharray="4 3" dot={false} />
              <Line type="monotone" dataKey="reel" name="Réel cumulé (km)" stroke={C.pine} strokeWidth={2} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}

      {vo2ProjectionSeries.points.length > 1 && (
        <Card style={{ marginBottom: 16 }}>
          <SectionLabel icon={Gauge}>VO2max — réelle et prévisionnelle</SectionLabel>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={vo2ProjectionSeries.points}>
              <CartesianGrid stroke={C.border} vertical={false} />
              <XAxis dataKey="date" tick={CHART_TEXT} tickFormatter={fmtDateFR} minTickGap={30} />
              <YAxis tick={CHART_TEXT} width={30} domain={["dataMin - 1", "dataMax + 1"]} />
              <Tooltip contentStyle={tooltipStyle()} labelFormatter={fmtDateFR} />
              <Legend wrapperStyle={{ fontSize: 11, color: C.muted }} />
              <Line type="monotone" dataKey="reel" name="VO2max réelle" stroke={C.gold} strokeWidth={2} connectNulls dot />
              {vo2ProjectionSeries.hasTarget && (
                <Line type="monotone" dataKey="previsionnel" name="Prévisionnelle (selon réalisation du programme)" stroke={C.blaze} strokeWidth={2} strokeDasharray="4 3" dot={false} />
              )}
            </LineChart>
          </ResponsiveContainer>
          {!vo2ProjectionSeries.hasTarget && (
            <p style={{ color: C.muted, fontSize: 11, marginTop: 8 }}>
              Ajoute une cible VO2max (onglet Programme → Cibles nominales) pour voir la prévisionnelle.
            </p>
          )}
        </Card>
      )}

      {weeklyVsPlanSeries.length > 0 && (
        <Card style={{ marginBottom: 20 }}>
          <SectionLabel icon={Activity}>Volume hebdo — réalisé vs prévu</SectionLabel>
          <ResponsiveContainer width="100%" height={190}>
            <ComposedChart data={weeklyVsPlanSeries}>
              <CartesianGrid stroke={C.border} vertical={false} />
              <XAxis dataKey="semaine" tick={CHART_TEXT} tickFormatter={fmtDateFR} minTickGap={20} />
              <YAxis tick={CHART_TEXT} width={30} />
              <Tooltip contentStyle={tooltipStyle()} labelFormatter={fmtDateFR} />
              <Legend wrapperStyle={{ fontSize: 11, color: C.muted }} />
              <Bar dataKey="reel" name="Réalisé (km)" fill={C.pine} radius={[3, 3, 0, 0]} />
              <Line type="monotone" dataKey="prevu" name="Prévu (km)" stroke={C.gold} strokeWidth={2} strokeDasharray="4 3" dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </Card>
      )}
    </>
  );
}

// ---------- Suivi macro par course — liste des courses avec % d'atteinte ----------
function CourseOverviewList({ goals, scores, onSelect }) {
  return (
    <>
      <SectionLabel icon={Flag}>Mes courses</SectionLabel>
      <div style={{ display: "grid", gap: 10, marginBottom: 20 }}>
        {goals.length === 0 && (
          <Card>
            <p style={{ color: C.muted, fontSize: 13 }}>Aucune course — ajoute-en une avec le bouton "+" ci-dessus.</p>
          </Card>
        )}
        {goals.map(g => {
          const d = daysUntil(g.date);
          const s = scores[g.id];
          const childOf = goals.find(o => o.id === g.isPrepFor);
          return (
            <button key={g.id} onClick={() => onSelect(g.id)}
              style={{ textAlign: "left", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, cursor: "pointer", color: "inherit", font: "inherit" }}>
              <div className="flex items-center justify-between">
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{g.nom}</div>
                  <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>
                    {fmtDateFR(g.date)} · {g.distance} km · {g.dplus || "—"} m D+
                    {childOf && <> · étape vers {childOf.nom}</>}
                  </div>
                </div>
                <div style={{ ...mono, fontSize: 20, fontWeight: 700, color: d < 0 ? C.muted : C.gold }}>{d < 0 ? "passée" : `J-${d}`}</div>
              </div>
              <div style={{ marginTop: 10 }}>
                <div className="flex items-center justify-between" style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>
                  <span>Atteinte de l'objectif</span>
                  <span style={{ ...mono, color: C.text }}>{s?.notStarted || s?.global == null ? "—" : `${s.global}%`}</span>
                </div>
                <ProgressBar pct={s?.global ?? 0} />
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

// ---------- Historique des sorties — carte "dernière sortie" + liste complète (façon Garmin Connect) ----------
function StatTile({ label, value, unit }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div>
      <div style={{ ...mono, fontSize: 17, fontWeight: 800, color: C.text }}>
        {value}{unit && <span style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}> {unit}</span>}
      </div>
      <div style={{ fontSize: 10.5, color: C.muted, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
    </div>
  );
}
function ActivityStatsGrid({ a, detailed = false }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      <StatTile label="Distance" value={a.distance_km} unit="km" />
      <StatTile label="FC moyenne" value={a.fc_moy} unit="bpm" />
      <StatTile label="Allure moyenne" value={a.allure} unit="/km" />
      <StatTile label="Durée" value={a.duree} />
      <StatTile label="D+" value={a.d_plus ? Math.round(a.d_plus) : null} unit="m" />
      <StatTile label="Calories" value={a.calories} unit="kcal" />
      {detailed && <>
        <StatTile label="D-" value={a.d_moins ? Math.round(a.d_moins) : null} unit="m" />
        <StatTile label="FC max" value={a.fc_max} unit="bpm" />
        <StatTile label="Vitesse max" value={a.vitesse_max} unit="km/h" />
        <StatTile label="VO2max estimée" value={a.vo2max} />
        <StatTile label="Cadence" value={a.cadence} unit="ppm" />
        <StatTile label="Puissance" value={a.puissance} unit="W" />
        <StatTile label="Température" value={a.temperature} unit="°C" />
        <StatTile label="Effet aérobie" value={a.teAerobie} />
        <StatTile label="Effet anaérobie" value={a.teAnaerobie} />
      </>}
    </div>
  );
}
function LastActivityCard({ activities, onViewAll }) {
  if (!activities.length) return null;
  const last = activities[activities.length - 1];
  return (
    <Card style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <SectionLabel icon={History}>Dernière sortie</SectionLabel>
        <button onClick={onViewAll} style={{ background: "none", border: "none", color: C.blaze, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
          Tout l'historique →
        </button>
      </div>
      <div style={{ fontWeight: 700, fontSize: 15 }}>{last.nom || last.type}</div>
      <div style={{ color: C.muted, fontSize: 12, marginBottom: 12 }}>{fmtDateFR(last.date)}</div>
      <ActivityStatsGrid a={last} />
    </Card>
  );
}
function ActivityHistoryList({ activities }) {
  const [openIdx, setOpenIdx] = useState(null);
  const sorted = useMemo(() => [...activities].sort((a, b) => new Date(b.date) - new Date(a.date)), [activities]);
  if (!sorted.length) {
    return <Card><p style={{ color: C.muted, fontSize: 13 }}>Aucune activité importée pour l'instant — va dans "Mes données" pour importer ton CSV Garmin.</p></Card>;
  }
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {sorted.map((a, i) => {
        const open = openIdx === i;
        return (
          <Card key={i}>
            <button onClick={() => setOpenIdx(open ? null : i)}
              style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, font: "inherit", textAlign: "left" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{a.nom || a.type}</div>
                <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>{fmtDateFR(a.date)} · {a.type}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ ...mono, fontSize: 14, color: C.pine, fontWeight: 700 }}>{a.distance_km}km</span>
                {open ? <ChevronUp size={16} color={C.muted} /> : <ChevronDown size={16} color={C.muted} />}
              </div>
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8, fontSize: 12, color: C.muted, flexWrap: "wrap" }}>
              {a.duree && <span>{a.duree}</span>}
              {a.allure && <span>{a.allure} /km</span>}
              {a.fc_moy && <span>{a.fc_moy} bpm</span>}
              {a.d_plus ? <span>{Math.round(a.d_plus)}m D+</span> : null}
            </div>
            {open && (
              <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 10, paddingTop: 10 }}>
                <ActivityStatsGrid a={a} detailed />
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ---------- Calendrier mensuel — vue macro des courses à venir ----------
function MonthCalendar({ goals }) {
  const [monthDate, setMonthDate] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  const year = monthDate.getFullYear(), month = monthDate.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth = new Date(year, month + 1, 0);
  const startGrid = startOfWeekMonday(firstOfMonth);
  const endGrid = addDays(startOfWeekMonday(lastOfMonth), 6);
  const days = [];
  for (let d = new Date(startGrid); d <= endGrid; d = addDays(d, 1)) days.push(new Date(d));
  const todayIso = isoDate(new Date());

  return (
    <Card style={{ marginBottom: 20 }}>
      <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
        <button onClick={() => setMonthDate(d => { const n = new Date(d); n.setMonth(n.getMonth() - 1); return n; })}
          style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 18, padding: "0 8px" }}>‹</button>
        <span style={{ fontSize: 13, fontWeight: 700, textTransform: "capitalize" }}>
          {monthDate.toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}
        </span>
        <button onClick={() => setMonthDate(d => { const n = new Date(d); n.setMonth(n.getMonth() + 1); return n; })}
          style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 18, padding: "0 8px" }}>›</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3, fontSize: 10, color: C.muted, marginBottom: 3, textAlign: "center", textTransform: "uppercase" }}>
        {DAY_ORDER.map(d => <div key={d}>{d}</div>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3 }}>
        {days.map((d, i) => {
          const iso = isoDate(d);
          const inMonth = d.getMonth() === month;
          const races = goals.filter(g => g.date === iso);
          return (
            <div key={i} style={{
              minHeight: 46, borderRadius: 6, padding: 3,
              background: iso === todayIso ? C.surfaceHi : "transparent",
              border: `1px solid ${iso === todayIso ? C.gold : C.border}`,
              opacity: inMonth ? 1 : 0.3,
            }}>
              <div style={{ ...mono, fontSize: 10, color: C.muted }}>{d.getDate()}</div>
              {races.map(g => (
                <div key={g.id} title={g.nom} style={{
                  marginTop: 2, fontSize: 9, fontWeight: 700, color: "#1A0D08", background: goalColor(goals, g.id),
                  borderRadius: 4, padding: "1px 3px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  🏁 {g.nom}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---------- Calendrier de la semaine en cours — séances de toutes les courses, taguées par course ----------
function SessionNote({ entry, onSave }) {
  const [editing, setEditing] = useState(false);
  const [score, setScore] = useState(entry?.score || "");
  const [note, setNote] = useState(entry?.note || "");

  if (editing) {
    return (
      <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
        <input type="number" min="1" max="10" value={score} onChange={e => setScore(e.target.value)} placeholder="/10"
          style={{ width: 42, flexShrink: 0, background: C.surfaceHi, color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: "3px 5px", fontSize: 11 }} />
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="Ressenti (optionnel)"
          style={{ flex: 1, minWidth: 0, background: C.surfaceHi, color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, padding: "3px 6px", fontSize: 11 }} />
        <button onClick={() => { if (score) { onSave(+score, note); setEditing(false); } }}
          style={{ background: "none", border: "none", color: C.pine, cursor: "pointer", padding: 0, flexShrink: 0 }}><Check size={15} /></button>
      </div>
    );
  }

  if (entry) {
    return (
      <button onClick={() => setEditing(true)} className="flex items-center gap-2"
        style={{ marginTop: 4, background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, textAlign: "left", font: "inherit", width: "100%" }}>
        <span className="flex items-center gap-1" style={{ ...mono, fontSize: 11, fontWeight: 700, color: C.gold, flexShrink: 0 }}>
          <BookOpen size={11} /> {entry.score}/10
        </span>
        {entry.note && <span style={{ fontSize: 11, color: C.muted, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>« {entry.note} »</span>}
      </button>
    );
  }

  return (
    <button onClick={() => setEditing(true)} className="flex items-center gap-1"
      style={{ marginTop: 4, background: "none", border: `1px dashed ${C.border}`, borderRadius: 4, padding: "2px 7px", color: C.muted, cursor: "pointer", fontSize: 11 }}>
      <BookOpen size={11} /> Noter cette séance
    </button>
  );
}

function WeekCalendar({ goals, plans, todayIso, journal, onSaveNote }) {
  if (!goals.length) return null;
  const weekStart = startOfWeekMonday(new Date());
  const days = DAY_ORDER.map((_, i) => isoDate(addDays(weekStart, i)));

  const sessionsByDay = days.map(iso => {
    const items = [];
    goals.forEach(g => {
      const plan = plans[g.id];
      const week = plan?.weeks.find(w => w.start <= iso && iso <= w.end);
      week?.sessions.filter(s => s.date === iso && !(s.type || "").includes("Repos")).forEach(s => items.push({ ...s, goal: g }));
    });
    return { date: iso, items };
  });

  return (
    <Card style={{ marginBottom: 20 }}>
      <SectionLabel icon={CalendarDays}>Cette semaine</SectionLabel>
      <div style={{ display: "grid", gap: 8 }}>
        {sessionsByDay.map((day, i) => (
          <div key={day.date} className="flex items-start gap-3" style={{ padding: "6px 0", borderBottom: i < 6 ? `1px solid ${C.border}` : "none" }}>
            <div style={{ width: 64, flexShrink: 0 }}>
              <div style={{ fontSize: 11, color: day.date === todayIso ? C.gold : C.muted, fontWeight: day.date === todayIso ? 700 : 400, textTransform: "uppercase" }}>
                {DAY_ORDER[i]}
              </div>
              <div style={{ ...mono, fontSize: 11, color: C.text }}>{fmtDateFR(day.date).replace(/\s\d{4}$/, "")}</div>
            </div>
            <div style={{ display: "grid", gap: 4, flex: 1 }}>
              {day.items.length === 0 ? (
                <span style={{ fontSize: 12, color: C.muted }}>—</span>
              ) : day.items.map((s, j) => (
                <div key={j} style={{ fontSize: 12 }}>
                  <div className="flex items-center gap-2">
                    <span style={{ background: goalColor(goals, s.goal.id), color: "#1A0D08", borderRadius: 4, padding: "1px 6px", fontSize: 10, fontWeight: 700, flexShrink: 0 }}>
                      {s.goal.nom}
                    </span>
                    <span>{s.type} · {s.estKm}km{s.estDplus ? ` · ${s.estDplus}m D+` : ""}{s.start ? ` · ${s.start}–${s.end}` : ""}</span>
                  </div>
                  <SessionNote entry={journal[day.date]} onSave={(score, note) => onSaveNote(day.date, score, note)} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------- Accordion (sections empilées, sans changement d'onglet) ----------
function AccordionSection({ title, icon: Icon, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 12 }}>
      <button onClick={() => setOpen(o => !o)} className="flex items-center justify-between"
        style={{ width: "100%", background: C.surfaceHi, border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 12px", cursor: "pointer" }}>
        <span className="flex items-center gap-2" style={{ color: C.text, fontSize: 13, fontWeight: 700 }}>
          {Icon && <Icon size={14} style={{ color: C.muted }} />} {title}
        </span>
        {open ? <ChevronUp size={16} color={C.muted} /> : <ChevronDown size={16} color={C.muted} />}
      </button>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}

// ---------- Goal detail (programme, cibles nominales, plan, score) — une seule page, sections empilées ----------
function GoalDetail({ goal, goals, plan, score, activities, onUpdate, onRemove, today }) {
  return (
    <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
      <div className="flex justify-end mb-2">
        <button onClick={onRemove} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer" }}><Trash2 size={14} /></button>
      </div>

      <AccordionSection title="Comparaison" icon={Target} defaultOpen>
        <ComparisonPanel plan={plan} goal={goal} onUpdate={onUpdate} />
      </AccordionSection>

      <AccordionSection title="Mon programme" icon={Settings2} defaultOpen>
        <ProgramEditor goal={goal} onUpdate={onUpdate} />
      </AccordionSection>

      <AccordionSection title="Plan semaine par semaine" icon={CalendarDays} defaultOpen={false}>
        {(goal.program?.sessions || []).length === 0 ? (
          <p style={{ color: C.muted, fontSize: 12 }}>Renseigne d'abord ton programme (section "Mon programme") pour voir le plan semaine par semaine.</p>
        ) : (
          <div>
            <div style={{ background: C.surfaceHi, borderRadius: 8, padding: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
                Objectif total sur la période (suggestion auto : {plan.suggestedKm}km · {plan.suggestedDplus}m D+ — ajustable)
              </div>
              <div className="flex gap-2">
                <input type="number" defaultValue={goal.targetKm || plan.suggestedKm} onBlur={e => onUpdate(g => ({ ...g, targetKm: +e.target.value || 0 }))} placeholder="Total km" style={inputStyle()} />
                <input type="number" defaultValue={goal.targetDplus || plan.suggestedDplus} onBlur={e => onUpdate(g => ({ ...g, targetDplus: +e.target.value || 0 }))} placeholder="Total D+ (m)" style={inputStyle()} />
              </div>
            </div>
            <div style={{ display: "grid", gap: 6, maxHeight: 340, overflowY: "auto" }}>
            {plan.weeks.map((w, i) => {
              const isPast = new Date(w.end) < today;
              const weekReal = activities.filter(a => { const d = new Date(a.date); return d >= new Date(w.start) && d <= new Date(w.end); });
              const weekRealKm = +weekReal.reduce((s, a) => s + (a.distance_km || 0), 0).toFixed(1);
              const weekRealDplus = Math.round(weekReal.reduce((s, a) => s + (a.d_plus || 0), 0));
              return (
                <div key={i} style={{ background: C.surfaceHi, borderRadius: 8, padding: 10, opacity: isPast ? 0.75 : 1 }}>
                  <div className="flex items-center justify-between" style={{ fontSize: 11, color: C.muted, marginBottom: 3 }}>
                    <span>{fmtDateFR(w.start)} → {fmtDateFR(w.end)}</span>
                    <span style={{ color: C.blaze, fontWeight: 700 }}>{w.phase}</span>
                  </div>
                  <div style={{ ...mono, fontSize: 11, color: C.pine, marginBottom: 6 }}>
                    {weekRealKm}/{w.targetKm}km · {weekRealDplus}/{w.targetDplus}m D+
                  </div>
                  <div style={{ display: "grid", gap: 3 }}>
                    {w.sessions.map((s, j) => {
                      const act = findActivity(s.date, activities);
                      const dow = new Date(s.date).getDay();
                      return (
                        <div key={j} className="flex items-center justify-between" style={{ fontSize: 12 }}>
                          <span>{DAY_ORDER[dow === 0 ? 6 : dow - 1]} · {s.type}</span>
                          <span style={{ ...mono, color: act ? C.pine : C.muted }}>
                            {act ? `✓ ${act.distance_km}km` : `${s.estKm}km / ${s.durationH}h`}
                          </span>
                        </div>
                      );
                    })}
                    {!w.sessions.length && <span style={{ color: C.muted, fontSize: 12 }}>Repos / pas de créneau</span>}
                  </div>
                </div>
              );
            })}
            </div>
          </div>
        )}
      </AccordionSection>

      <AccordionSection title="Cibles nominales" icon={Target} defaultOpen={false}>
        <NominalTargetsEditor goal={goal} activities={activities} onUpdate={onUpdate} />
      </AccordionSection>

      <AccordionSection title="Détail du score" icon={Gauge} defaultOpen={false}>
        {score?.notStarted || score?.global == null ? (
          <p style={{ color: C.muted, fontSize: 12 }}>Pas encore de séance à comparer à ce jour — vérifie ton programme ci-dessus.</p>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {Object.entries(score?.breakdown || {}).map(([k, v]) => (
              <div key={k}>
                <div className="flex items-center justify-between" style={{ fontSize: 11, color: C.muted, marginBottom: 3 }}>
                  <span>{k}</span><span style={{ ...mono, color: C.text }}>{v}%</span>
                </div>
                <ProgressBar pct={v} color={C.pine} />
              </div>
            ))}
          </div>
        )}
      </AccordionSection>
    </div>
  );
}

function ProgramEditor({ goal, onUpdate }) {
  const [day, setDay] = useState("lun");
  const [type, setType] = useState("");
  const [km, setKm] = useState("");
  const [dplus, setDplus] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const sessions = goal.program?.sessions || [];
  function addSession() {
    if (!type || km === "") return;
    onUpdate(g => ({ ...g, program: { ...g.program, sessions: [...(g.program?.sessions || []), { id: Date.now(), day, type, km: +km, dplus: dplus ? +dplus : 0, start: start || null, end: end || null }] } }));
    setType(""); setKm(""); setDplus(""); setStart(""); setEnd("");
  }
  function removeSession(id) {
    onUpdate(g => ({ ...g, program: { ...g.program, sessions: g.program.sessions.filter(s => s.id !== id) } }));
  }
  const totalKm = +sessions.reduce((s, x) => s + (+x.km || 0), 0).toFixed(1);
  const totalDplus = Math.round(sessions.reduce((s, x) => s + (+x.dplus || 0), 0));
  return (
    <div>
      <p style={{ color: C.muted, fontSize: 11, marginBottom: 10 }}>
        Ton programme type, une semaine (il se répète à l'identique chaque semaine). Marque "Repos" dans le type pour une séance de récup qui ne compte pas dans le suivi.
      </p>
      <div style={{ display: "grid", gap: 6, marginBottom: 10 }}>
        {sessions.map(s => (
          <div key={s.id} className="flex items-center justify-between" style={{ background: C.surfaceHi, borderRadius: 6, padding: "6px 10px", fontSize: 13 }}>
            <span>{s.day} · {s.type} · {s.km}km{s.dplus ? ` · ${s.dplus}m D+` : ""}{s.start ? ` · ${s.start}–${s.end}` : ""}</span>
            <button onClick={() => removeSession(s.id)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer" }}><X size={14} /></button>
          </div>
        ))}
        {sessions.length > 0 && (
          <div style={{ ...mono, fontSize: 12, color: C.pine, marginTop: 2 }}>Total programme : {totalKm}km / semaine · {totalDplus}m D+ / semaine</div>
        )}
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <div className="flex gap-2">
          <select value={day} onChange={e => setDay(e.target.value)} style={inputStyle()}>
            {DAY_ORDER.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <input value={type} onChange={e => setType(e.target.value)} placeholder="Type (ex: Sortie longue)" style={inputStyle()} />
        </div>
        <div className="flex gap-2">
          <input type="number" value={km} onChange={e => setKm(e.target.value)} placeholder="Km" style={inputStyle()} />
          <input type="number" value={dplus} onChange={e => setDplus(e.target.value)} placeholder="D+ (m, optionnel)" style={inputStyle()} />
        </div>
        <div className="flex gap-2">
          <input type="time" value={start} onChange={e => setStart(e.target.value)} style={inputStyle()} />
          <input type="time" value={end} onChange={e => setEnd(e.target.value)} style={inputStyle()} />
          <button onClick={addSession} style={btnStyle(true)}><Plus size={14} /></button>
        </div>
      </div>
      <textarea value={goal.program?.notes || ""} onChange={e => onUpdate(g => ({ ...g, program: { ...g.program, notes: e.target.value } }))}
        placeholder="Notes libres"
        style={{ width: "100%", height: 50, background: C.surfaceHi, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: 8, fontSize: 12, marginTop: 8 }} />
    </div>
  );
}

function ComparisonPanel({ plan, goal, onUpdate }) {
  if (!(goal.program?.sessions || []).length) {
    return <p style={{ color: C.muted, fontSize: 12 }}>Renseigne ton programme (onglet "Mon programme") pour voir s'il matche l'objectif.</p>;
  }
  const verdictColor = { ok: C.pine, insuffisant: C.brick, excessif: C.gold };
  const verdictLabel = { ok: "Ça matche", insuffisant: "Insuffisant", excessif: "Trop chargé" };
  const flexSession = [...(goal.program.sessions || [])].sort((a, b) => (b.km || 0) - (a.km || 0))[0];
  return (
    <div>
      <div style={{ background: C.surfaceHi, borderRadius: 8, padding: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
          Cible totale sur la période (suggestion auto : {plan.suggestedKm}km · {plan.suggestedDplus}m D+ — ajustable)
        </div>
        <div className="flex gap-2">
          <input type="number" defaultValue={goal.targetKm || plan.suggestedKm} onBlur={e => onUpdate(g => ({ ...g, targetKm: +e.target.value || 0 }))} placeholder="Total km" style={inputStyle()} />
          <input type="number" defaultValue={goal.targetDplus || plan.suggestedDplus} onBlur={e => onUpdate(g => ({ ...g, targetDplus: +e.target.value || 0 }))} placeholder="Total D+ (m)" style={inputStyle()} />
        </div>
        <div style={{ ...mono, fontSize: 12, color: C.text, marginTop: 8 }}>
          Ton programme : {plan.templateKm}km / semaine · {plan.templateDplus}m D+ / semaine (constant)
        </div>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {plan.phaseComparison.map((p, i) => (
          <div key={i} style={{ background: C.surfaceHi, borderRadius: 8, padding: 10 }}>
            <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{p.phase} <span style={{ color: C.muted, fontWeight: 400 }}>({p.weeks} sem.)</span></span>
              <span style={{ fontSize: 11, fontWeight: 700, color: verdictColor[p.verdict] }}>{verdictLabel[p.verdict]}</span>
            </div>
            <div style={{ ...mono, fontSize: 12, color: C.muted }}>
              Besoin ≈ {p.avgKm}km / {p.avgDplus}m D+ par semaine
            </div>
            {p.verdict !== "ok" && (
              <p style={{ fontSize: 12, marginTop: 6, color: C.text }}>
                {p.deltaKm < 0
                  ? `Ajoute environ ${Math.abs(p.deltaKm)}km/semaine — augmente "${flexSession?.type}"${flexSession?.start ? ` (${flexSession.day} ${flexSession.start}–${flexSession.end}, même créneau)` : ` (${flexSession?.day}, même jour)`}.`
                  : p.phase === "Affûtage"
                    ? `Réduis d'environ ${Math.abs(p.deltaKm)}km/semaine sur cette phase (typiquement en affûtage, c'est volontaire).`
                    : `Ton programme dépasse le besoin de cette phase, pas d'ajustement nécessaire sauf si tu sens une fatigue excessive.`}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function NominalTargetsEditor({ goal, activities, onUpdate }) {
  const [label, setLabel] = useState(""); const [type, setType] = useState("vo2max");
  const [start, setStart] = useState(""); const [target, setTarget] = useState("");
  const targets = goal.nominalTargets || [];
  function addTarget() {
    if (!label || start === "" || target === "") return;
    onUpdate(g => ({ ...g, nominalTargets: [...(g.nominalTargets || []), { id: Date.now(), label, type, start: +start, target: +target, direction: type === "allure" ? "lower" : "higher" }] }));
    setLabel(""); setStart(""); setTarget("");
  }
  function removeTarget(id) {
    onUpdate(g => ({ ...g, nominalTargets: g.nominalTargets.filter(t => t.id !== id) }));
  }
  return (
    <div>
      <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
        {targets.map(t => {
          const { current, progress } = nominalProgress(t, activities);
          return (
            <div key={t.id} style={{ background: C.surfaceHi, borderRadius: 8, padding: 10 }}>
              <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t.label}</span>
                <button onClick={() => removeTarget(t.id)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer" }}><X size={14} /></button>
              </div>
              <div className="flex items-center justify-between" style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>
                <span style={{ ...mono }}>{current} → {t.target}</span><span style={{ ...mono }}>{Math.round(progress * 100)}%</span>
              </div>
              <ProgressBar pct={progress * 100} color={C.gold} />
            </div>
          );
        })}
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Ex : VO2max" style={inputStyle()} />
        <select value={type} onChange={e => setType(e.target.value)} style={inputStyle()}>
          <option value="vo2max">VO2max (auto)</option>
          <option value="allure">Allure seuil min/km (auto)</option>
          <option value="sortie_longue">Sortie la plus longue km (auto)</option>
          <option value="custom">Autre (manuel)</option>
        </select>
        <div className="flex gap-2">
          <input value={start} onChange={e => setStart(e.target.value)} placeholder="Valeur actuelle" style={inputStyle()} />
          <input value={target} onChange={e => setTarget(e.target.value)} placeholder="Objectif" style={inputStyle()} />
        </div>
        <button onClick={addTarget} style={btnStyle(true)}>Ajouter la cible</button>
      </div>
    </div>
  );
}


function PersonalDataForm({ profile, onUpdate }) {
  function setField(key) { return e => onUpdate({ ...profile, [key]: e.target.value }); }
  return (
    <Card style={{ marginBottom: 20 }}>
      <SectionLabel icon={User}>Données personnelles</SectionLabel>
      <div style={{ display: "grid", gap: 8 }}>
        <input defaultValue={profile.prenom || ""} onBlur={setField("prenom")} placeholder="Prénom" style={inputStyle()} />
        <div className="flex gap-2">
          <input type="date" defaultValue={profile.naissance || ""} onBlur={setField("naissance")} style={inputStyle()} />
          <input type="number" defaultValue={profile.poids || ""} onBlur={setField("poids")} placeholder="Poids (kg)" style={inputStyle()} />
          <input type="number" defaultValue={profile.taille || ""} onBlur={setField("taille")} placeholder="Taille (cm)" style={inputStyle()} />
        </div>
        <div className="flex gap-2">
          <input type="number" defaultValue={profile.fcRepos || ""} onBlur={setField("fcRepos")} placeholder="FC repos (bpm)" style={inputStyle()} />
          <input type="number" defaultValue={profile.fcMax || ""} onBlur={setField("fcMax")} placeholder="FC max (bpm)" style={inputStyle()} />
        </div>
      </div>
    </Card>
  );
}

function GoalForm({ goals, onCancel, onSave }) {
  const [nom, setNom] = useState(""); const [date, setDate] = useState("");
  const [distance, setDistance] = useState(""); const [dplus, setDplus] = useState("");
  const [isPrepFor, setIsPrepFor] = useState("");
  return (
    <div style={{ background: C.surfaceHi, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
      <div className="flex items-center justify-between mb-2">
        <span style={{ fontSize: 13, fontWeight: 700 }}>Nouvelle course</span>
        <button onClick={onCancel} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer" }}><X size={16} /></button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <input value={nom} onChange={e => setNom(e.target.value)} placeholder="Nom de la course" style={inputStyle()} />
        <div className="flex gap-2">
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle()} />
          <input value={distance} onChange={e => setDistance(e.target.value)} placeholder="Distance (km)" style={inputStyle()} />
          <input value={dplus} onChange={e => setDplus(e.target.value)} placeholder="D+ (m)" style={inputStyle()} />
        </div>
        {goals.length > 0 && (
          <select value={isPrepFor} onChange={e => setIsPrepFor(e.target.value)} style={inputStyle()}>
            <option value="">Objectif indépendant</option>
            {goals.map(g => <option key={g.id} value={g.id}>Étape de préparation pour : {g.nom}</option>)}
          </select>
        )}
        <button onClick={() => nom && date && distance && onSave({ nom, date, distance: +distance, dplus: dplus ? +dplus : 0, isPrepFor: isPrepFor || null })} style={btnStyle(true)}>
          Ajouter
        </button>
      </div>
    </div>
  );
}
