import React, { useState, useEffect, useMemo, useRef } from "react";
import Papa from "papaparse";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend
} from "recharts";
import {
  Upload, Mountain, Flag, Plus, Trash2, X, ChevronDown, ChevronUp,
  TrendingUp, Activity, Gauge, CalendarDays, Settings2, Target, BookOpen
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
  return <div className="flex items-center gap-2 mb-3" style={{ color: C.muted }}>
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
  const [loading, setLoading] = useState(true);
  const [expandedGoal, setExpandedGoal] = useState(null);
  const [showGoalForm, setShowGoalForm] = useState(false);
  const [importMode, setImportMode] = useState("file");
  const [pasteText, setPasteText] = useState("");
  const [error, setError] = useState("");
  const fileInput = useRef(null);
  const today = new Date();

  useEffect(() => {
    (async () => {
      try { const a = await storage.get("activities"); if (a?.value) setActivities(JSON.parse(a.value)); } catch (e) {}
      try { const g = await storage.get("goals"); if (g?.value) setGoals(JSON.parse(g.value)); } catch (e) {}
      try { const j = await storage.get("journal"); if (j?.value) setJournal(JSON.parse(j.value)); } catch (e) {}
      setLoading(false);
    })();
  }, []);

  async function persistActivities(rows) { setActivities(rows); try { await storage.set("activities", JSON.stringify(rows)); } catch (e) { console.error(e); } }
  async function persistGoals(list) { setGoals(list); try { await storage.set("goals", JSON.stringify(list)); } catch (e) { console.error(e); } }
  async function persistJournal(obj) { setJournal(obj); try { await storage.set("journal", JSON.stringify(obj)); } catch (e) { console.error(e); } }

  function handleParsed(rows) {
    const clean = rows.filter(r => r.date).map(r => ({
      date: r.date, nom: r.nom, type: r.type,
      distance_km: parseFloat(r.distance_km) || 0,
      allure: r.allure_min_par_km, allure_min: paceToMin(r.allure_min_par_km),
      d_plus: parseFloat(r.d_plus_m) || 0,
      fc_moy: parseFloat(r.fc_moyenne) || null,
      vo2max: parseFloat(r.vo2max_estime) || null,
    })).sort((a, b) => new Date(a.date) - new Date(b.date));
    const byDate = new Map(activities.map(a => [a.date + a.nom, a]));
    clean.forEach(c => byDate.set(c.date + c.nom, c));
    const merged = [...byDate.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
    persistActivities(merged);
    setError("");
  }
  function onFile(e) { const f = e.target.files?.[0]; if (!f) return; Papa.parse(f, { header: true, skipEmptyLines: true, complete: r => handleParsed(r.data) }); }
  function onPasteImport() { if (!pasteText.trim()) { setError("Colle d'abord le contenu du CSV."); return; } Papa.parse(pasteText, { header: true, skipEmptyLines: true, complete: r => handleParsed(r.data) }); }

  function addGoal(g) { const withId = { ...g, id: Date.now().toString(), program: { sessions: [], notes: "" }, nominalTargets: [] }; persistGoals([...goals, withId]); setShowGoalForm(false); }
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

  const needsJournal = useMemo(() => {
    const cutoff = Date.now() - 14 * 86400000;
    return activities.filter(a => new Date(a.date).getTime() >= cutoff && !journal[a.date]);
  }, [activities, journal]);

  const vo2Series = useMemo(() => activities.filter(a => a.vo2max).map(a => ({ date: a.date, vo2max: a.vo2max })), [activities]);
  const weekly = useMemo(() => {
    const map = {};
    activities.forEach(a => {
      const wk = startOfWeekMonday(new Date(a.date)).toISOString().slice(0, 10);
      if (!map[wk]) map[wk] = { semaine: wk, distance_km: 0, d_plus: 0 };
      map[wk].distance_km += a.distance_km; map[wk].d_plus += a.d_plus;
    });
    return Object.values(map).sort((a, b) => new Date(a.semaine) - new Date(b.semaine)).slice(-12).map(w => ({ ...w, distance_km: +w.distance_km.toFixed(1) }));
  }, [activities]);

  if (loading) return <div style={{ background: C.bg, color: C.muted, minHeight: 400, display: "flex", alignItems: "center", justifyContent: "center" }}>Chargement…</div>;

  return (
    <div style={{ background: C.bg, color: C.text, minHeight: "100vh", fontFamily: "ui-sans-serif, system-ui, sans-serif" }}>
      <div style={{ borderBottom: `1px solid ${C.border}`, padding: "24px 20px 18px" }}>
        <div className="flex items-center gap-2" style={{ color: C.blaze }}>
          <Mountain size={18} /><span style={{ fontSize: 12, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 700 }}>Carnet de trail</span>
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 800, marginTop: 6 }}>Objectifs & préparation</h1>
      </div>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "20px" }}>
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

        {needsJournal.length > 0 && (
          <Card style={{ marginBottom: 20 }}>
            <SectionLabel icon={BookOpen}>Journal — note ces sorties</SectionLabel>
            <div style={{ display: "grid", gap: 8 }}>
              {needsJournal.map((a, i) => (
                <JournalPrompt key={i} activity={a} onSave={(score, note) => persistJournal({ ...journal, [a.date]: { score, note } })} />
              ))}
            </div>
          </Card>
        )}

        <SectionLabel icon={Flag}>Objectifs</SectionLabel>
        <div style={{ display: "grid", gap: 10, marginBottom: 20 }}>
          {goals.map(g => {
            const d = daysUntil(g.date);
            const score = scores[g.id];
            const isExpanded = expandedGoal === g.id;
            const childOf = goals.find(o => o.id === g.isPrepFor);
            return (
              <Card key={g.id}>
                <div className="flex items-center justify-between">
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{g.nom}</div>
                    <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>
                      {fmtDateFR(g.date)} · {g.distance} km · {g.dplus || "—"} m D+
                      {childOf && <> · étape vers {childOf.nom}</>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div style={{ ...mono, fontSize: 20, fontWeight: 700, color: d < 0 ? C.muted : C.gold }}>{d < 0 ? "passée" : `J-${d}`}</div>
                    <button onClick={() => setExpandedGoal(isExpanded ? null : g.id)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer" }}>
                      {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                    </button>
                  </div>
                </div>
                <div style={{ marginTop: 10 }}>
                  <div className="flex items-center justify-between" style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>
                    <span>Atteinte de l'objectif</span>
                    <span style={{ ...mono, color: C.text }}>{score?.notStarted || score?.global == null ? "—" : `${score.global}%`}</span>
                  </div>
                  {score?.notStarted || score?.global == null
                    ? <p style={{ color: C.muted, fontSize: 11 }}>Renseigne tes disponibilités pour activer le suivi.</p>
                    : <>
                        <ProgressBar pct={score.global} />
                        <p style={{ color: C.muted, fontSize: 11, marginTop: 5, ...mono }}>
                          Cumul : {score.cumulative.realKm}/{score.cumulative.idealKm}km · {score.cumulative.realDplus}/{score.cumulative.idealDplus}m D+
                        </p>
                      </>}
                </div>
                {isExpanded && (
                  <GoalDetail goal={g} goals={goals} plan={plans[g.id]} score={score} activities={activities}
                    onUpdate={updater => updateGoal(g.id, updater)} onRemove={() => { removeGoal(g.id); setExpandedGoal(null); }} today={today} />
                )}
              </Card>
            );
          })}
          {!showGoalForm ? (
            <button onClick={() => setShowGoalForm(true)} className="flex items-center gap-2 justify-center"
              style={{ border: `1px dashed ${C.border}`, borderRadius: 10, padding: 12, color: C.muted, background: "none", cursor: "pointer", fontSize: 13 }}>
              <Plus size={14} /> Ajouter une course
            </button>
          ) : <GoalForm goals={goals} onCancel={() => setShowGoalForm(false)} onSave={addGoal} />}
        </div>

        {goals.length > 1 && (
          <Card style={{ marginBottom: 20 }}>
            <SectionLabel icon={Target}>Vue globale</SectionLabel>
            <div style={{ display: "grid", gap: 10 }}>
              {goals.map(g => (
                <div key={g.id} className="flex items-center justify-between">
                  <span style={{ fontSize: 13 }}>{g.nom}</span>
                  <div className="flex items-center gap-2" style={{ width: "55%" }}>
                    <ProgressBar pct={scores[g.id]?.global ?? 0} />
                    <span style={{ ...mono, fontSize: 12, width: 32, textAlign: "right" }}>{scores[g.id]?.notStarted || scores[g.id]?.global == null ? "—" : `${scores[g.id].global}%`}</span>
                  </div>
                </div>
              ))}
            </div>
            <p style={{ color: C.muted, fontSize: 11, marginTop: 10 }}>
              Les courses marquées "étape vers" partagent leurs semaines de préparation avec l'objectif final — leur résultat nourrit le score de l'objectif suivant.
            </p>
          </Card>
        )}

        {activities.length > 0 && (
          <>
            {vo2Series.length > 1 && (
              <Card style={{ marginBottom: 16 }}>
                <SectionLabel icon={Gauge}>VO2max estimé</SectionLabel>
                <ResponsiveContainer width="100%" height={160}>
                  <LineChart data={vo2Series}>
                    <CartesianGrid stroke={C.border} vertical={false} />
                    <XAxis dataKey="date" tick={CHART_TEXT} tickFormatter={fmtDateFR} minTickGap={30} />
                    <YAxis tick={CHART_TEXT} width={30} domain={["dataMin - 1", "dataMax + 1"]} />
                    <Tooltip contentStyle={tooltipStyle()} labelFormatter={fmtDateFR} />
                    <Line type="monotone" dataKey="vo2max" stroke={C.gold} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </Card>
            )}
            {weekly.length > 1 && (
              <Card>
                <SectionLabel icon={Activity}>Charge hebdomadaire</SectionLabel>
                <ResponsiveContainer width="100%" height={190}>
                  <ComposedChart data={weekly}>
                    <CartesianGrid stroke={C.border} vertical={false} />
                    <XAxis dataKey="semaine" tick={CHART_TEXT} tickFormatter={fmtDateFR} minTickGap={20} />
                    <YAxis yAxisId="l" tick={CHART_TEXT} width={30} />
                    <YAxis yAxisId="r" orientation="right" tick={CHART_TEXT} width={30} />
                    <Tooltip contentStyle={tooltipStyle()} labelFormatter={fmtDateFR} />
                    <Legend wrapperStyle={{ fontSize: 11, color: C.muted }} />
                    <Bar yAxisId="l" dataKey="distance_km" name="Distance (km)" fill={C.pine} radius={[3, 3, 0, 0]} />
                    <Line yAxisId="r" type="monotone" dataKey="d_plus" name="D+ (m)" stroke={C.blaze} strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------- Goal detail (programme, cibles nominales, plan, score) ----------
function GoalDetail({ goal, goals, plan, score, activities, onUpdate, onRemove, today }) {
  const [tab, setTab] = useState("comparaison");
  return (
    <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
      <div className="flex gap-2 mb-3">
        {[["comparaison", "Comparaison"], ["programme", "Mon programme"], ["plan", "Plan"], ["cibles", "Cibles"], ["score", "Détail score"]].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={btnStyle(tab === k)}>{label}</button>
        ))}
        <button onClick={onRemove} style={{ marginLeft: "auto", background: "none", border: "none", color: C.muted, cursor: "pointer" }}><Trash2 size={14} /></button>
      </div>

      {tab === "programme" && <ProgramEditor goal={goal} onUpdate={onUpdate} />}
      {tab === "comparaison" && <ComparisonPanel plan={plan} goal={goal} onUpdate={onUpdate} />}
      {tab === "cibles" && <NominalTargetsEditor goal={goal} activities={activities} onUpdate={onUpdate} />}
      {tab === "score" && (
        score?.notStarted || score?.global == null ? (
          <p style={{ color: C.muted, fontSize: 12 }}>Pas encore de séance à comparer à ce jour — vérifie ton programme dans l'onglet dédié.</p>
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
        )
      )}
      {tab === "plan" && (
        (goal.program?.sessions || []).length === 0 ? (
          <p style={{ color: C.muted, fontSize: 12 }}>Renseigne d'abord ton programme (onglet "Mon programme") pour voir le plan semaine par semaine.</p>
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
        )
      )}
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
                  : `Réduis d'environ ${Math.abs(p.deltaKm)}km/semaine sur cette phase (typiquement en affûtage, c'est volontaire).`}
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

function JournalPrompt({ activity, onSave }) {
  const [score, setScore] = useState(""); const [note, setNote] = useState("");
  return (
    <div style={{ background: C.surfaceHi, borderRadius: 8, padding: 10 }}>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>{fmtDateFR(activity.date)} · {activity.nom} · {activity.distance_km}km</div>
      <div className="flex gap-2">
        <input type="number" min="1" max="10" value={score} onChange={e => setScore(e.target.value)} placeholder="/10" style={{ ...inputStyle(), flex: "0 0 60px" }} />
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="Ressenti (optionnel)" style={inputStyle()} />
        <button onClick={() => score && onSave(+score, note)} style={btnStyle(true)}>Noter</button>
      </div>
    </div>
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
