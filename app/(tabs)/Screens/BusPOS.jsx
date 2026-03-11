import { useState, useEffect, useCallback } from "react";
import api from '../API/api';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─────────────────────────────────────────────────────────────────────────────
// Local Ticket Store — persists POS tickets on device for 48 hours
// ─────────────────────────────────────────────────────────────────────────────
const TICKET_KEY = 'pos_local_tickets';
const TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

const LocalTicketStore = {
  getAll: async () => {
    try {
      const raw = await AsyncStorage.getItem(TICKET_KEY);
      if (!raw) return [];
      const tickets = JSON.parse(raw);
      const now = Date.now();
      const valid = tickets.filter(t => now - new Date(t.issued_at).getTime() < TTL_MS);
      if (valid.length !== tickets.length) await AsyncStorage.setItem(TICKET_KEY, JSON.stringify(valid));
      return valid;
    } catch (e) { return []; }
  },
  save: async (ticket) => {
    try {
      const existing = await LocalTicketStore.getAll();
      const entry = { ...ticket, issued_at: ticket.issued_at || new Date().toISOString(), source: 'POS' };
      await AsyncStorage.setItem(TICKET_KEY, JSON.stringify([entry, ...existing]));
      return entry;
    } catch (e) { console.warn('LocalTicketStore.save', e); }
  },
  getByTrip: async (tripId) => {
    const all = await LocalTicketStore.getAll();
    return all.filter(t => String(t.trip_id) === String(tripId));
  },
  expiresIn: (issued_at) => {
    const rem = TTL_MS - (Date.now() - new Date(issued_at).getTime());
    if (rem <= 0) return 'EXPIRED';
    const hrs = Math.floor(rem / 3600000);
    const mins = Math.floor((rem % 3600000) / 60000);
    return hrs > 0 ? `${hrs}h ${mins}m left` : `${mins}m left`;
  },
};



// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const shortStop = (name) => {
  if (!name || name === "Unknown") return "?";
  const parts = name.split("-");
  return parts.length >= 2 ? parts[1].trim() : name;
};
const formatTime = (iso) => { if (!iso) return "—"; return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
const formatDate = (iso) => { if (!iso) return "—"; return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" }); };
const formatDuration = (start, end) => {
  if (!start) return "—";
  const mins = Math.round((new Date(end || Date.now()) - new Date(start)) / 60000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared UI primitives
// ─────────────────────────────────────────────────────────────────────────────
const STATUS_CFG = {
  running:   { bg: "#0d2a12", border: "#2a6", text: "#4dbb6d", label: "RUNNING",   dot: "#4dbb6d" },
  paused:    { bg: "#2a1d00", border: "#a70", text: "#f0a500", label: "PAUSED",    dot: "#f0a500" },
  completed: { bg: "#0a1a2a", border: "#25a", text: "#5ab4e0", label: "COMPLETED", dot: "#5ab4e0" },
  cancelled: { bg: "#2a0a0a", border: "#a22", text: "#d96",    label: "CANCELLED", dot: "#d96"    },
};
const StatusBadge = ({ status }) => {
  const c = STATUS_CFG[status] || { bg: "#1a1a1a", border: "#444", text: "#888", label: status?.toUpperCase(), dot: "#888" };
  return (
    <span style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.text, fontSize: 9, padding: "3px 8px", letterSpacing: 1.5, display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.dot, display: "inline-block", boxShadow: `0 0 6px ${c.dot}` }} />
      {c.label}
    </span>
  );
};

const Spinner = ({ color = "#f0a500", size = 18 }) => (
  <span style={{ display: "inline-block", width: size, height: size, border: `2px solid ${color}33`, borderTopColor: color, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
);

const Toast = ({ msg, type }) => (
  <div style={{ position: "fixed", top: 16, right: 16, zIndex: 9999, background: type === "error" ? "#2a0a0a" : "#0a2a12", border: `1px solid ${type === "error" ? "#a44" : "#4a9"}`, color: type === "error" ? "#d96" : "#6dba6d", padding: "10px 16px", fontSize: 11, letterSpacing: 1, animation: "slideIn 0.25s ease", maxWidth: 280, fontFamily: "inherit" }}>
    {type === "error" ? "✗ " : "✓ "}{msg}
  </div>
);

const SectionHeader = ({ title, right }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
    <div style={{ fontSize: 10, letterSpacing: 2, color: "#888", display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ color: "#f0a500" }}>▸</span> {title}
    </div>
    {right}
  </div>
);

const Card = ({ children, style = {}, accent }) => (
  <div style={{ background: "#0f0f0f", border: "1px solid #1e1e1e", borderLeft: accent ? `3px solid ${accent}` : undefined, padding: 16, marginBottom: 12, ...style }}>
    {children}
  </div>
);

const PillBtn = ({ label, active, onClick, color = "#f0a500" }) => (
  <button onClick={onClick} style={{ padding: "5px 12px", background: active ? color : "transparent", border: `1px solid ${active ? color : "#333"}`, color: active ? "#000" : "#666", fontSize: 10, letterSpacing: 1, cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s" }}>{label}</button>
);

const ActionBtn = ({ label, icon, color, bg, onClick, disabled, loading }) => (
  <button onClick={onClick} disabled={disabled || loading} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "10px 6px", background: bg || "#1a1a1a", border: `1px solid ${color}33`, color, fontSize: 10, letterSpacing: 1, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: disabled ? 0.5 : 1, transition: "all 0.15s" }}>
    {loading ? <Spinner color={color} size={16} /> : <span style={{ fontSize: 18 }}>{icon}</span>}
    {label}
  </button>
);

// ─────────────────────────────────────────────────────────────────────────────
// Mini Bar Chart
// ─────────────────────────────────────────────────────────────────────────────
const MiniBarChart = ({ data }) => {
  if (!data || !data.length) return null;
  const max = Math.max(...data.map((d) => d.collection), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 70, marginTop: 12 }}>
      {data.map((d, i) => (
        <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
          <div style={{ fontSize: 8, color: "#555" }}>₹{d.collection >= 1000 ? (d.collection / 1000).toFixed(1) + "k" : d.collection}</div>
          <div style={{ width: "100%", background: "#f0a500", borderRadius: 2, height: Math.max(4, (d.collection / max) * 44), transition: "height 0.4s ease" }} />
          <div style={{ fontSize: 8, color: "#444" }}>{d.date.slice(5)}</div>
        </div>
      ))}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Stage Filter (shared between Active Trip card and Report Modal)
// ─────────────────────────────────────────────────────────────────────────────
const StageFilter = ({ tripId, baseTickets, baseCollection, compact = false }) => {
  const [stops, setStops] = useState([]);
  const [stopsLoading, setStopsLoading] = useState(false);
  const [fromStop, setFromStop] = useState(null);
  const [toStop, setToStop] = useState(null);
  const [pickingFrom, setPickingFrom] = useState(false);
  const [pickingTo, setPickingTo] = useState(false);
  const [filtered, setFiltered] = useState(null);
  const [filtering, setFiltering] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => { if (expanded && tripId && !stops.length) fetchStops(); }, [expanded, tripId]);
  useEffect(() => { setStops([]); setFromStop(null); setToStop(null); setFiltered(null); setExpanded(false); }, [tripId]);

  const fetchStops = async () => {
    setStopsLoading(true);
    try { const r = await api.get(`/conductor/trip/${tripId}/stages`); setStops(r.data?.stops || []); }
    catch (e) { console.log(e); } finally { setStopsLoading(false); }
  };

  const applyFilter = async (from, to) => {
    if (!from && !to) { setFiltered(null); return; }
    setFiltering(true);
    try {
      const params = [];
      if (from) params.push(`from_stop=${from.id}`);
      if (to) params.push(`to_stop=${to.id}`);
      const r = await api.get(`/conductor/trip/${tripId}/stage-collection?${params.join("&")}`);
      setFiltered(r.data);
    } catch (e) { alert("Could not filter stages"); } finally { setFiltering(false); }
  };

  const selectFrom = (s) => { setFromStop(s); setPickingFrom(false); applyFilter(s, toStop); };
  const selectTo = (s) => { setToStop(s); setPickingTo(false); applyFilter(fromStop, s); };
  const clearFilter = () => { setFromStop(null); setToStop(null); setFiltered(null); };

  const isFiltered = !!(fromStop || toStop);
  const displayTickets = isFiltered ? (filtered?.summary?.total_tickets ?? 0) : baseTickets;
  const displayCollection = isFiltered ? (filtered?.summary?.total_collection ?? 0) : baseCollection;

  return (
    <div style={{ marginTop: 10 }}>
      <button onClick={() => setExpanded((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 6, background: expanded ? "#f0a500" : "transparent", border: `1px solid ${expanded ? "#f0a500" : "#444"}`, color: expanded ? "#000" : "#f0a500", padding: "6px 12px", fontSize: 10, letterSpacing: 1.5, cursor: "pointer", fontFamily: "inherit" }}>
        ⊞ STAGE FILTER {isFiltered && <span style={{ background: "#f55", color: "#fff", borderRadius: "50%", width: 8, height: 8, display: "inline-block" }} />}
        {expanded ? " ▲" : " ▼"}
      </button>

      {expanded && (
        <div style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", padding: 12, marginTop: 6 }}>
          {/* Stats row */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <div style={{ flex: 1, background: "#111", border: "1px solid #1a1a1a", padding: "8px 12px", textAlign: "center" }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#f0a500", fontFamily: "'Barlow Condensed', sans-serif" }}>{displayTickets}</div>
              <div style={{ fontSize: 9, color: "#555", letterSpacing: 1 }}>TICKETS</div>
            </div>
            <div style={{ flex: 1, background: "#111", border: "1px solid #1a1a1a", padding: "8px 12px", textAlign: "center" }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#4dbb6d", fontFamily: "'Barlow Condensed', sans-serif" }}>₹{Number(displayCollection).toFixed(0)}</div>
              <div style={{ fontSize: 9, color: "#555", letterSpacing: 1 }}>REVENUE</div>
            </div>
          </div>

          {stopsLoading ? <div style={{ textAlign: "center", padding: 10 }}><Spinner /></div>
            : stops.length === 0 ? <div style={{ fontSize: 11, color: "#444", textAlign: "center", padding: 8, fontStyle: "italic" }}>No stops data yet</div>
            : (
              <>
                {/* Pickers */}
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                  <button onClick={() => { setPickingFrom((v) => !v); setPickingTo(false); }} style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, background: fromStop ? "#1a1200" : "#111", border: `1px solid ${fromStop ? "#f0a500" : "#333"}`, color: fromStop ? "#f0a500" : "#666", padding: "7px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
                    ◎ {fromStop ? shortStop(fromStop.name) : "From Stage"}
                    {fromStop && <span onClick={(e) => { e.stopPropagation(); setFromStop(null); applyFilter(null, toStop); }} style={{ marginLeft: "auto", cursor: "pointer" }}>✕</span>}
                  </button>
                  <span style={{ color: "#444" }}>→</span>
                  <button onClick={() => { setPickingTo((v) => !v); setPickingFrom(false); }} style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, background: toStop ? "#1a1200" : "#111", border: `1px solid ${toStop ? "#f0a500" : "#333"}`, color: toStop ? "#f0a500" : "#666", padding: "7px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
                    ▼ {toStop ? shortStop(toStop.name) : "To Stage"}
                    {toStop && <span onClick={(e) => { e.stopPropagation(); setToStop(null); applyFilter(fromStop, null); }} style={{ marginLeft: "auto", cursor: "pointer" }}>✕</span>}
                  </button>
                </div>

                {/* From dropdown */}
                {pickingFrom && (
                  <div style={{ background: "#111", border: "1px solid #222", maxHeight: 160, overflowY: "auto", marginBottom: 8 }}>
                    <div style={{ fontSize: 9, color: "#666", letterSpacing: 1.5, padding: "6px 10px", background: "#0a0a0a" }}>SELECT FROM STAGE</div>
                    {stops.map((s) => (
                      <div key={s.id} onClick={() => selectFrom(s)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid #1a1a1a", cursor: "pointer", background: fromStop?.id === s.id ? "#1a1200" : "transparent", color: fromStop?.id === s.id ? "#f0a500" : "#ccc", fontSize: 12 }}>
                        <span style={{ fontSize: 10, color: "#f0a500", minWidth: 24 }}>{shortStop(s.name)}</span>
                        <span style={{ flex: 1 }}>{s.name}</span>
                        {fromStop?.id === s.id && <span>✓</span>}
                      </div>
                    ))}
                  </div>
                )}

                {/* To dropdown */}
                {pickingTo && (
                  <div style={{ background: "#111", border: "1px solid #222", maxHeight: 160, overflowY: "auto", marginBottom: 8 }}>
                    <div style={{ fontSize: 9, color: "#666", letterSpacing: 1.5, padding: "6px 10px", background: "#0a0a0a" }}>SELECT TO STAGE</div>
                    {stops.map((s) => (
                      <div key={s.id} onClick={() => selectTo(s)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid #1a1a1a", cursor: "pointer", background: toStop?.id === s.id ? "#1a1200" : "transparent", color: toStop?.id === s.id ? "#f0a500" : "#ccc", fontSize: 12 }}>
                        <span style={{ fontSize: 10, color: "#f0a500", minWidth: 24 }}>{shortStop(s.name)}</span>
                        <span style={{ flex: 1 }}>{s.name}</span>
                        {toStop?.id === s.id && <span>✓</span>}
                      </div>
                    ))}
                  </div>
                )}

                {filtering && <div style={{ textAlign: "center", padding: 8 }}><Spinner /></div>}

                {/* Filter result */}
                {isFiltered && !filtering && filtered && (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#0d2a12", border: "1px solid #2a5a2a", padding: "6px 10px", fontSize: 10, color: "#6dba6d", marginBottom: 8 }}>
                      ✓ {displayTickets} ticket{displayTickets !== 1 ? "s" : ""}{fromStop ? ` from ${shortStop(fromStop.name)}` : ""}{toStop ? ` to ${shortStop(toStop.name)}` : ""} · ₹{Number(displayCollection).toFixed(2)}
                      <button onClick={clearFilter} style={{ marginLeft: "auto", background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 12 }}>✕</button>
                    </div>

                    {/* Breakdown table */}
                    {filtered.route_breakdown?.length > 0 && (
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                        <thead>
                          <tr style={{ background: "#1a1200" }}>
                            {["SS", "ES", "F", "H", "FR", "AMT"].map((h) => (
                              <th key={h} style={{ padding: "5px 6px", color: "#f0a500", fontSize: 9, letterSpacing: 1, fontWeight: 700, textAlign: h === "AMT" ? "right" : "center" }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {filtered.route_breakdown.map((rb, i) => (
                            <tr key={i} style={{ background: i % 2 === 0 ? "#0a0a0a" : "#111", borderBottom: "1px solid #1a1a1a" }}>
                              <td style={{ padding: "5px 6px", color: "#ccc", textAlign: "center", maxWidth: 50, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortStop(rb.from)}</td>
                              <td style={{ padding: "5px 6px", color: "#ccc", textAlign: "center", maxWidth: 50, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortStop(rb.to)}</td>
                              <td style={{ padding: "5px 6px", color: "#ddd", textAlign: "center" }}>{rb.full_count || "-"}</td>
                              <td style={{ padding: "5px 6px", color: "#ddd", textAlign: "center" }}>{rb.half_count || "-"}</td>
                              <td style={{ padding: "5px 6px", color: "#ddd", textAlign: "center" }}>{rb.free_count || "-"}</td>
                              <td style={{ padding: "5px 6px", color: "#f0a500", textAlign: "right", fontWeight: 700 }}>₹{Number(rb.total_fare ?? rb.revenue ?? 0).toFixed(0)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </>
                )}
              </>
            )}
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Trip Report Modal
// ─────────────────────────────────────────────────────────────────────────────
const TripReportModal = ({ tripId, onClose }) => {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { if (tripId) fetchReport(); else setReport(null); }, [tripId]);

  const fetchReport = async () => {
    setLoading(true);
    try { const r = await api.get(`/conductor/trip/${tripId}/report`); setReport(r.data); }
    catch (e) { alert("Could not load trip report"); } finally { setLoading(false); }
  };

  const s = report?.summary || {};

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", borderBottom: "none", width: "100%", maxWidth: 420, maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: "1px solid #1a1a1a", background: "#111" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", letterSpacing: 1 }}>TRIP REPORT</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 18 }}>✕</button>
        </div>
        <div style={{ overflowY: "auto", padding: 16, flex: 1 }}>
          {loading ? <div style={{ textAlign: "center", padding: 40 }}><Spinner size={32} /></div>
            : report ? (
              <>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 16, color: "#fff", fontWeight: 700 }}>{report.route_name}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                    <StatusBadge status={report.status} />
                    <span style={{ fontSize: 11, color: "#666" }}>{formatTime(report.start_time)}{report.end_time ? ` – ${formatTime(report.end_time)}` : " – ongoing"} · {formatDuration(report.start_time, report.end_time)}</span>
                  </div>
                </div>

                <StageFilter tripId={tripId} baseTickets={s.total_tickets || 0} baseCollection={s.total_collection || 0} />

                {/* Summary cards */}
                <div style={{ display: "flex", gap: 8, marginTop: 14, marginBottom: 14, flexWrap: "wrap" }}>
                  {[
                    { label: "Full", value: s.total_full ?? 0, color: "#f0a500" },
                    ...(Number(s.total_half) > 0 ? [{ label: "Half", value: s.total_half, color: "#e08020" }] : []),
                    ...(Number(s.total_free) > 0 ? [{ label: "Free", value: s.total_free, color: "#6dba6d" }] : []),
                    { label: "Amount", value: `₹${Number(s.total_collection ?? 0).toFixed(0)}`, color: "#5ab4e0" },
                  ].map((c) => (
                    <div key={c.label} style={{ flex: 1, minWidth: 70, background: "#111", border: "1px solid #1e1e1e", padding: "10px 8px", textAlign: "center" }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: c.color, fontFamily: "'Barlow Condensed', sans-serif" }}>{c.value}</div>
                      <div style={{ fontSize: 9, color: "#555", letterSpacing: 1 }}>{c.label.toUpperCase()}</div>
                    </div>
                  ))}
                </div>

                {/* Stage-wise table */}
                {report.route_breakdown?.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 10, color: "#888", letterSpacing: 2, marginBottom: 8 }}>▸ STAGE-WISE REPORT</div>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead>
                        <tr style={{ background: "#1a1200" }}>
                          {["SS", "ES", "F", "H", "FR", "AMT"].map((h) => (
                            <th key={h} style={{ padding: "6px", color: "#f0a500", fontSize: 9, letterSpacing: 1, fontWeight: 700, textAlign: h === "AMT" ? "right" : "center" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {report.route_breakdown.map((rb, i) => (
                          <tr key={i} style={{ background: i % 2 === 0 ? "#0a0a0a" : "#111", borderBottom: "1px solid #1a1a1a" }}>
                            <td style={{ padding: "6px", color: "#ccc", textAlign: "center" }}>{shortStop(rb.from)}</td>
                            <td style={{ padding: "6px", color: "#ccc", textAlign: "center" }}>{shortStop(rb.to)}</td>
                            <td style={{ padding: "6px", textAlign: "center", color: "#ddd" }}>{rb.full_count || "-"}</td>
                            <td style={{ padding: "6px", textAlign: "center", color: "#ddd" }}>{rb.half_count || "-"}</td>
                            <td style={{ padding: "6px", textAlign: "center", color: "#ddd" }}>{rb.free_count || "-"}</td>
                            <td style={{ padding: "6px", textAlign: "right", color: "#f0a500", fontWeight: 700 }}>₹{Number(rb.total_fare ?? rb.revenue ?? 0).toFixed(0)}</td>
                          </tr>
                        ))}
                        <tr style={{ background: "#1a1200", borderTop: "1px solid #f0a500" }}>
                          <td colSpan={2} style={{ padding: "6px", color: "#f0a500", fontWeight: 700, fontSize: 10, letterSpacing: 1 }}>TOTAL</td>
                          <td style={{ padding: "6px", textAlign: "center", color: "#fff", fontWeight: 700 }}>{s.total_full ?? 0}</td>
                          <td style={{ padding: "6px", textAlign: "center", color: "#fff", fontWeight: 700 }}>{s.total_half > 0 ? s.total_half : "-"}</td>
                          <td style={{ padding: "6px", textAlign: "center", color: "#fff", fontWeight: 700 }}>{s.total_free > 0 ? s.total_free : "-"}</td>
                          <td style={{ padding: "6px", textAlign: "right", color: "#f0a500", fontWeight: 800 }}>₹{Number(s.total_collection ?? 0).toFixed(0)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Ticket details */}
                {report.tickets?.length > 0 && (
                  <div>
                    <div style={{ fontSize: 10, color: "#888", letterSpacing: 2, marginBottom: 8 }}>▸ TICKET DETAILS ({report.tickets.length})</div>
                    {report.tickets.map((t, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #1a1a1a" }}>
                        <div>
                          <div style={{ fontSize: 12, color: "#ddd" }}>{shortStop(t.from || "?")} → {shortStop(t.to || "?")}</div>
                          <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>{formatTime(t.created_at)} · {t.source || "POS"}</div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: 14, color: "#f0a500", fontWeight: 700 }}>₹{Number(t.fare ?? t.amount ?? 0).toFixed(0)}</div>
                          <div style={{ display: "flex", gap: 4, marginTop: 2, justifyContent: "flex-end" }}>
                            {t.is_verified && <span style={{ fontSize: 9, color: "#6dba6d" }}>✓ VERIFIED</span>}
                            {t.is_free && <span style={{ fontSize: 9, color: "#a070f0" }}>FREE</span>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : null}
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Passengers Modal
// ─────────────────────────────────────────────────────────────────────────────
const PassengersModal = ({ tripId, onClose }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(null);

  useEffect(() => { if (tripId) fetchPassengers(); }, [tripId]);

  const fetchPassengers = async () => {
    setLoading(true);
    try { const r = await api.get(`/conductor/passengers/${tripId}`); setData(r.data); }
    catch (e) { alert("Could not load passengers"); } finally { setLoading(false); }
  };

  const handleVerify = async (ticketId) => {
    setVerifying(ticketId);
    try {
      await api.post(`/conductor/ticket/${ticketId}/verify`);
      setData((prev) => ({ ...prev, passengers: prev.passengers.map((p) => p.ticket_id === ticketId ? { ...p, is_verified: true } : p) }));
    } catch (e) { alert("Could not verify ticket"); } finally { setVerifying(null); }
  };

  const passengers = data?.passengers || [];
  const verified = passengers.filter((p) => p.is_verified).length;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", borderBottom: "none", width: "100%", maxWidth: 420, maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: "1px solid #1a1a1a", background: "#111" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", letterSpacing: 1 }}>PASSENGERS</div>
            {data && <div style={{ fontSize: 10, color: "#888", marginTop: 2 }}>{data.passenger_count} total · {verified} verified</div>}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 18 }}>✕</button>
        </div>
        <div style={{ overflowY: "auto", padding: 16, flex: 1 }}>
          {loading ? <div style={{ textAlign: "center", padding: 40 }}><Spinner size={32} /></div>
            : passengers.length === 0 ? (
              <div style={{ textAlign: "center", padding: 40, color: "#444" }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>👥</div>
                <div style={{ fontSize: 12, letterSpacing: 2 }}>NO PASSENGERS YET</div>
              </div>
            ) : passengers.map((p, i) => (
              <div key={p.ticket_id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid #1a1a1a" }}>
                <div style={{ width: 32, height: 32, background: "#111", border: "1px solid #2a2a2a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, color: "#f0a500", flexShrink: 0 }}>
                  {i + 1}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: "#ddd" }}>{shortStop(p.from || "?")} → {shortStop(p.to || "?")}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 3 }}>
                    <span style={{ fontSize: 11, color: "#f0a500", fontWeight: 700 }}>₹{p.amount}</span>
                    {p.is_verified && <span style={{ fontSize: 9, color: "#6dba6d" }}>✓ VERIFIED</span>}
                    {p.is_free && <span style={{ fontSize: 9, color: "#a070f0" }}>FREE</span>}
                    <span style={{ fontSize: 9, color: p.source === "APP" ? "#5ab4e0" : "#888" }}>{p.source}</span>
                  </div>
                </div>
                {!p.is_verified && (
                  <button onClick={() => handleVerify(p.ticket_id)} disabled={verifying === p.ticket_id} style={{ background: "#0d2a12", border: "1px solid #2a6a2a", color: "#6dba6d", padding: "5px 10px", fontSize: 10, letterSpacing: 1, cursor: "pointer", fontFamily: "inherit" }}>
                    {verifying === p.ticket_id ? <Spinner size={12} color="#6dba6d" /> : "VERIFY"}
                  </button>
                )}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Start Trip Modal
// ─────────────────────────────────────────────────────────────────────────────
const StartTripModal = ({ onClose, onStarted }) => {
  const [routes, setRoutes] = useState([]);
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [direction, setDirection] = useState("up");
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);

  useEffect(() => { fetchRoutes(); }, []);

  const fetchRoutes = async () => {
    setFetching(true);
    try { const r = await api.get("/conductor/routes"); setRoutes(r.data?.routes || []); }
    catch (e) { setRoutes([]); } finally { setFetching(false); }
  };

  const handleStart = async () => {
    if (!selectedRoute) { alert("Please select a route"); return; }
    setLoading(true);
    try {
      const r = await api.post("/conductor/trip/start", { route_id: selectedRoute, direction });
      if (r.data?.success) { onStarted(r.data); onClose(); }
    } catch (e) { alert(e?.message || "Failed to start trip"); } finally { setLoading(false); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", borderBottom: "none", width: "100%", maxWidth: 420, padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", letterSpacing: 1 }}>START NEW TRIP</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 18 }}>✕</button>
        </div>

        <div style={{ fontSize: 9, color: "#888", letterSpacing: 2, marginBottom: 8 }}>SELECT ROUTE</div>
        {fetching ? <div style={{ textAlign: "center", padding: 20 }}><Spinner /></div>
          : routes.length === 0 ? <div style={{ color: "#555", fontSize: 12, padding: 10 }}>No routes available</div>
          : (
            <div style={{ maxHeight: 200, overflowY: "auto", marginBottom: 16 }}>
              {routes.map((r) => (
                <div key={r.id} onClick={() => setSelectedRoute(r.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 12px", borderBottom: "1px solid #1a1a1a", cursor: "pointer", background: selectedRoute === r.id ? "#1a1200" : "transparent", color: selectedRoute === r.id ? "#f0a500" : "#ccc", fontSize: 13 }}>
                  <span style={{ fontSize: 16 }}>🚌</span>
                  <span style={{ flex: 1 }}>{r.name}</span>
                  {selectedRoute === r.id && <span>✓</span>}
                </div>
              ))}
            </div>
          )}

        <div style={{ fontSize: 9, color: "#888", letterSpacing: 2, marginBottom: 8 }}>DIRECTION</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          {[{ id: "up", label: "→ FORWARD (UP)" }, { id: "dn", label: "← RETURN (DN)" }].map((d) => (
            <button key={d.id} onClick={() => setDirection(d.id)} style={{ flex: 1, padding: "10px", background: direction === d.id ? "#f0a500" : "transparent", border: `1px solid ${direction === d.id ? "#f0a500" : "#333"}`, color: direction === d.id ? "#000" : "#666", fontSize: 11, letterSpacing: 1, cursor: "pointer", fontFamily: "inherit" }}>{d.label}</button>
          ))}
        </div>

        <button onClick={handleStart} disabled={loading} style={{ width: "100%", padding: "14px", background: loading ? "#333" : "#f0a500", color: loading ? "#666" : "#000", fontSize: 13, letterSpacing: 2, fontFamily: "inherit", fontWeight: 700, border: "none", cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          {loading ? <><Spinner color="#666" /> STARTING...</> : "▶ START TRIP"}
        </button>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Sell Ticket Modal
// ─────────────────────────────────────────────────────────────────────────────
const SellTicketModal = ({ trip, onClose, onIssued, showToast }) => {
  const [stops, setStops] = useState([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [ticketType, setTicketType] = useState("full"); // full | half | free
  const [payMethod, setPayMethod] = useState("cash");
  const [issuing, setIssuing] = useState(false);
  const [receipt, setReceipt] = useState(null);

  useEffect(() => { if (trip?.trip_id) fetchStops(); }, [trip]);

  const fetchStops = async () => {
    try { const r = await api.get(`/conductor/trip/${trip.trip_id}/stages`); setStops(r.data?.stops || []); }
    catch (e) { console.log(e); }
  };

  const calcFare = () => {
    if (!from || !to) return 0;
    const fi = stops.findIndex((s) => s.name === from);
    const ti = stops.findIndex((s) => s.name === to);
    if (fi === -1 || ti === -1) return 0;
    const base = Math.abs(ti - fi) * 30 + 20;
    return ticketType === "half" ? Math.ceil(base / 2) : ticketType === "free" ? 0 : base;
  };

  const handleIssue = async () => {
    if (!from || !to) { showToast("Select boarding and drop stop", "error"); return; }
    if (from === to) { showToast("From and To cannot be same", "error"); return; }
    const amount = calcFare();
    setIssuing(true);
    try {
      const r = await api.post("/conductor/ticket/issue", { from, to, amount, ticket_type: ticketType, payment_method: payMethod, trip_id: trip.trip_id });
      if (r.data?.success) {
        const ticket = r.data.ticket;
        // Save to local device storage for 48 hours
        await LocalTicketStore.save({
          ...ticket,
          trip_id: trip.trip_id,
          route_name: trip.route_name,
          ticket_type: ticketType,
          payment_method: payMethod,
          from,
          to,
          amount,
        });
        setReceipt(ticket);
        onIssued();
      }
    } catch (e) { showToast("Failed to issue ticket", "error"); } finally { setIssuing(false); }
  };

  const fare = calcFare();

  if (receipt) return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.9)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", borderBottom: "none", width: "100%", maxWidth: 420, padding: 20 }}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 40, color: "#6dba6d", marginBottom: 8 }}>✓</div>
          <div style={{ fontSize: 16, color: "#fff", fontWeight: 700, letterSpacing: 2 }}>TICKET ISSUED</div>
        </div>
        <div style={{ background: "#111", border: "1px solid #1a1a1a", padding: 16, marginBottom: 16 }}>
          <div style={{ textAlign: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: "#555", letterSpacing: 2 }}>TICKET ID</div>
            <div style={{ fontSize: 24, color: "#f0a500", fontWeight: 800, fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: 3 }}>{receipt.ticket_id}</div>
          </div>
          {[["FROM", shortStop(receipt.from)], ["TO", shortStop(receipt.to)], ["TYPE", ticketType.toUpperCase()], ["PAYMENT", payMethod.toUpperCase()], ["AMOUNT", `₹${receipt.amount}`]].map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #1a1a1a", padding: "6px 0" }}>
              <span style={{ fontSize: 10, color: "#555", letterSpacing: 1 }}>{k}</span>
              <span style={{ fontSize: 12, color: "#ddd" }}>{v}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { setReceipt(null); setFrom(""); setTo(""); }} style={{ flex: 1, padding: 12, background: "#f0a500", color: "#000", border: "none", fontSize: 12, letterSpacing: 2, fontFamily: "inherit", fontWeight: 700, cursor: "pointer" }}>+ NEW TICKET</button>
          <button onClick={onClose} style={{ flex: 1, padding: 12, background: "transparent", color: "#888", border: "1px solid #333", fontSize: 12, letterSpacing: 2, fontFamily: "inherit", cursor: "pointer" }}>DONE</button>
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#0a0a0a", border: "1px solid #2a2a2a", borderBottom: "none", width: "100%", maxWidth: 420, maxHeight: "85vh", overflowY: "auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", letterSpacing: 1 }}>ISSUE TICKET</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 18 }}>✕</button>
        </div>

        {/* Route info */}
        <div style={{ background: "#111", border: "1px solid #1a1a2a", padding: "8px 12px", marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 18 }}>🚌</span>
          <div>
            <div style={{ fontSize: 12, color: "#ddd" }}>{trip?.route_name}</div>
            <div style={{ fontSize: 10, color: "#555" }}>{trip?.direction} · {trip?.trip_id}</div>
          </div>
        </div>

        {/* From / To */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 9, color: "#888", letterSpacing: 2, marginBottom: 6 }}>BOARDING STOP</div>
            <select value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: "100%", background: "#111", border: "1px solid #333", color: from ? "#fff" : "#555", padding: "9px 10px", fontSize: 11, fontFamily: "inherit" }}>
              <option value="">— Select —</option>
              {stops.map((s) => <option key={s.id} value={s.name}>{shortStop(s.name)}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 9, color: "#888", letterSpacing: 2, marginBottom: 6 }}>DROP STOP</div>
            <select value={to} onChange={(e) => setTo(e.target.value)} style={{ width: "100%", background: "#111", border: "1px solid #333", color: to ? "#fff" : "#555", padding: "9px 10px", fontSize: 11, fontFamily: "inherit" }}>
              <option value="">— Select —</option>
              {stops.filter((s) => s.name !== from).map((s) => <option key={s.id} value={s.name}>{shortStop(s.name)}</option>)}
            </select>
          </div>
        </div>

        {/* Ticket type */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 9, color: "#888", letterSpacing: 2, marginBottom: 6 }}>TICKET TYPE</div>
          <div style={{ display: "flex", gap: 6 }}>
            {[{ id: "full", label: "FULL" }, { id: "half", label: "HALF" }, { id: "free", label: "FREE" }].map((t) => (
              <button key={t.id} onClick={() => setTicketType(t.id)} style={{ flex: 1, padding: "8px", background: ticketType === t.id ? "#f0a500" : "transparent", border: `1px solid ${ticketType === t.id ? "#f0a500" : "#333"}`, color: ticketType === t.id ? "#000" : "#666", fontSize: 10, letterSpacing: 1, cursor: "pointer", fontFamily: "inherit" }}>{t.label}</button>
            ))}
          </div>
        </div>

        {/* Fare preview */}
        {from && to && (
          <div style={{ background: "#0d1f0d", border: "1px solid #2a4a2a", padding: "10px 14px", marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "#6dba6d", letterSpacing: 1 }}>FARE</span>
            <span style={{ fontSize: 26, fontWeight: 800, color: "#6dba6d", fontFamily: "'Barlow Condensed', sans-serif" }}>
              {ticketType === "free" ? "FREE" : `₹${fare}`}
            </span>
          </div>
        )}

        {/* Payment method */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 9, color: "#888", letterSpacing: 2, marginBottom: 6 }}>PAYMENT</div>
          <div style={{ display: "flex", gap: 6 }}>
            {[{ id: "cash", label: "💵 CASH" }, { id: "upi", label: "📱 UPI" }, { id: "card", label: "💳 CARD" }].map((m) => (
              <button key={m.id} onClick={() => setPayMethod(m.id)} style={{ flex: 1, padding: "8px", background: payMethod === m.id ? "#1a1200" : "transparent", border: `1px solid ${payMethod === m.id ? "#f0a500" : "#333"}`, color: payMethod === m.id ? "#f0a500" : "#666", fontSize: 10, letterSpacing: 1, cursor: "pointer", fontFamily: "inherit" }}>{m.label}</button>
            ))}
          </div>
        </div>

        <button onClick={handleIssue} disabled={issuing || !from || !to} style={{ width: "100%", padding: "14px", background: !from || !to ? "#1a1a1a" : "#f0a500", color: !from || !to ? "#444" : "#000", fontSize: 13, letterSpacing: 2, fontFamily: "inherit", fontWeight: 700, border: "none", cursor: !from || !to ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          {issuing ? <><Spinner color="#888" /> ISSUING...</> : `▶ ISSUE TICKET${ticketType !== "free" && from && to ? ` — ₹${fare}` : ""}`}
        </button>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Tickets Screen — local device storage (48h) + live server tickets
// ─────────────────────────────────────────────────────────────────────────────
const TicketsScreen = ({ activeTrip, onVerify }) => {
  const [localTickets, setLocalTickets] = useState([]);
  const [serverTickets, setServerTickets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(null);
  const [tab, setTab] = useState("local"); // "local" | "server"

  useEffect(() => {
    if (activeTrip?.trip_id) {
      loadLocalTickets();
      fetchServerTickets();
    } else {
      setLocalTickets([]);
      setServerTickets([]);
    }
  }, [activeTrip?.trip_id]);

  const loadLocalTickets = async () => {
    const tickets = await LocalTicketStore.getByTrip(activeTrip.trip_id);
    setLocalTickets(tickets);
  };

  const fetchServerTickets = async () => {
    setLoading(true);
    try {
      const r = await api.get(`/conductor/passengers/${activeTrip.trip_id}`);
      setServerTickets(r.data?.passengers || []);
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const handleVerify = async (ticketId) => {
    setVerifying(ticketId);
    try {
      await api.post(`/conductor/ticket/${ticketId}/verify`);
      setServerTickets((prev) => prev.map((t) => t.ticket_id === ticketId ? { ...t, is_verified: true } : t));
      onVerify && onVerify(ticketId);
    } catch (e) { alert("Could not verify ticket"); } finally { setVerifying(null); }
  };

  const displayTickets = tab === "local" ? localTickets : serverTickets;

  const TicketCard = ({ t, showExpiry = false }) => (
    <div key={t.ticket_id} style={{ background: "#0f0f0f", border: "1px solid #1e1e1e", borderLeft: `3px solid ${t.source === "APP" ? "#5ab4e0" : "#f0a500"}`, padding: "10px 12px", marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <div style={{ fontSize: 10, color: "#666" }}>{t.ticket_id}</div>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <span style={{ fontSize: 8, padding: "2px 6px", background: t.source === "APP" ? "#0a1a2a" : "#1a1200", color: t.source === "APP" ? "#5ab4e0" : "#f0a500", letterSpacing: 1 }}>{t.source || "POS"}</span>
          {t.is_verified && <span style={{ fontSize: 8, padding: "2px 6px", background: "#0d2a12", color: "#6dba6d", letterSpacing: 1 }}>✓ VERIFIED</span>}
          {(t.is_free || t.ticket_type === "free") && <span style={{ fontSize: 8, padding: "2px 6px", background: "#1a0a2a", color: "#a070f0", letterSpacing: 1 }}>FREE</span>}
          {t.ticket_type === "half" && <span style={{ fontSize: 8, padding: "2px 6px", background: "#1a1200", color: "#f0a500", letterSpacing: 1 }}>HALF</span>}
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 13, color: "#ddd" }}>{shortStop(t.from || "?")} → {shortStop(t.to || "?")}</div>
          <div style={{ fontSize: 9, color: "#444", marginTop: 2, display: "flex", gap: 8 }}>
            <span>{formatTime(t.issued_at || t.created_at)}</span>
            {t.payment_method && <span style={{ color: "#555" }}>{t.payment_method.toUpperCase()}</span>}
            {showExpiry && t.issued_at && (
              <span style={{ color: "#666" }}>⏱ {LocalTicketStore.expiresIn(t.issued_at)}</span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 18, color: "#f0a500", fontWeight: 700, fontFamily: "'Barlow Condensed', sans-serif" }}>₹{t.amount}</div>
          {tab === "server" && !t.is_verified && (
            <button onClick={() => handleVerify(t.ticket_id)} disabled={verifying === t.ticket_id} style={{ background: "#0d2a12", border: "1px solid #2a5a2a", color: "#6dba6d", padding: "4px 8px", fontSize: 9, letterSpacing: 1, cursor: "pointer", fontFamily: "inherit" }}>
              {verifying === t.ticket_id ? <Spinner size={10} color="#6dba6d" /> : "VERIFY"}
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="fade-up">
      <SectionHeader
        title="TICKETS"
        right={
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10, color: "#f0a500" }}>{displayTickets.length} TOTAL</span>
            {activeTrip && (
              <button onClick={() => { loadLocalTickets(); fetchServerTickets(); }} style={{ background: "none", border: "1px solid #333", color: "#888", padding: "3px 8px", fontSize: 9, letterSpacing: 1, cursor: "pointer", fontFamily: "inherit" }}>
                ↻ REFRESH
              </button>
            )}
          </div>
        }
      />

      {/* Tab switcher */}
      {activeTrip && (
        <div style={{ display: "flex", gap: 0, marginBottom: 12, border: "1px solid #2a2a2a" }}>
          <button onClick={() => setTab("local")} style={{ flex: 1, padding: "8px", background: tab === "local" ? "#1a1200" : "transparent", borderRight: "1px solid #2a2a2a", color: tab === "local" ? "#f0a500" : "#555", fontSize: 10, letterSpacing: 1, cursor: "pointer", fontFamily: "inherit", border: "none", borderRight: "1px solid #2a2a2a", borderBottom: tab === "local" ? "2px solid #f0a500" : "2px solid transparent" }}>
            📱 THIS DEVICE ({localTickets.length})
          </button>
          <button onClick={() => setTab("server")} style={{ flex: 1, padding: "8px", background: tab === "server" ? "#0a1a2a" : "transparent", color: tab === "server" ? "#5ab4e0" : "#555", fontSize: 10, letterSpacing: 1, cursor: "pointer", fontFamily: "inherit", border: "none", borderBottom: tab === "server" ? "2px solid #5ab4e0" : "2px solid transparent" }}>
            ☁ SERVER ({serverTickets.length})
          </button>
        </div>
      )}

      {!activeTrip ? (
        <div style={{ textAlign: "center", padding: 40, color: "#444" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🚌</div>
          <div style={{ fontSize: 11, letterSpacing: 2 }}>NO ACTIVE TRIP</div>
          <div style={{ fontSize: 10, color: "#333", marginTop: 6 }}>Start a trip to see tickets</div>
        </div>
      ) : loading && tab === "server" ? (
        <div style={{ textAlign: "center", padding: 40 }}><Spinner size={28} /></div>
      ) : displayTickets.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "#444" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🎟</div>
          <div style={{ fontSize: 11, letterSpacing: 2 }}>
            {tab === "local" ? "NO LOCAL TICKETS YET" : "NO SERVER TICKETS YET"}
          </div>
          {tab === "local" && <div style={{ fontSize: 10, color: "#333", marginTop: 6 }}>Issued tickets will appear here for 48 hours</div>}
        </div>
      ) : (
        displayTickets.map((t, i) => (
          <TicketCard key={t.ticket_id || i} t={t} showExpiry={tab === "local"} />
        ))
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────────────────────────────────────
export default function BusPOS() {
  const [screen, setScreen] = useState("home"); // home | sell | tickets | collection
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusChanging, setStatusChanging] = useState(false);
  const [collectionPeriod, setCollectionPeriod] = useState("today");
  const [collection, setCollection] = useState(null);
  const [collectionLoading, setCollectionLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [clock, setClock] = useState(new Date());

  // Modals
  const [reportTripId, setReportTripId] = useState(null);
  const [passengersTripId, setPassengersTripId] = useState(null);
  const [showStartTrip, setShowStartTrip] = useState(false);
  const [showSellTicket, setShowSellTicket] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { fetchDashboard(); fetchCollection("today"); }, []);

  const showToast = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchDashboard = async () => {
    try { const r = await api.get("/conductor/dashboard"); setDashboard(r.data); }
    catch (e) { console.error(e); } finally { setLoading(false); setRefreshing(false); }
  };

  const fetchCollection = async (period) => {
    setCollectionLoading(true);
    try { const r = await api.get(`/conductor/collection/summary?period=${period}`); setCollection(r.data); }
    catch (e) { console.error(e); } finally { setCollectionLoading(false); }
  };

  const onRefresh = async () => { setRefreshing(true); await Promise.all([fetchDashboard(), fetchCollection(collectionPeriod)]); };

  const changeStatus = async (newStatus) => {
    const trip = dashboard?.active_trip;
    if (!trip) return;
    const msg = newStatus === "completed" ? "End this trip?" : newStatus === "paused" ? "Pause current trip?" : "Resume the trip?";
    if (!confirm(msg)) return;
    setStatusChanging(true);
    try {
      await api.post(`/conductor/trip/${trip.trip_id}/status`, { status: newStatus });
      showToast(newStatus === "completed" ? "Trip ended!" : newStatus === "paused" ? "Trip paused" : "Trip resumed");
      fetchDashboard();
    } catch (e) { showToast("Could not change status", "error"); } finally { setStatusChanging(false); }
  };

  const activeTrip = dashboard?.active_trip;
  const stats = dashboard?.today_stats || {};
  const recentTrips = (dashboard?.recent_trips || []).filter((t) => t.start_time && new Date(t.start_time).getTime() >= Date.now() - 24 * 3600000);

  if (loading) return (
    <div style={{ background: "#0a0a0a", minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "'Share Tech Mono', monospace" }}>
      <Spinner size={40} />
      <div style={{ color: "#555", fontSize: 11, letterSpacing: 2, marginTop: 16 }}>LOADING DASHBOARD...</div>
    </div>
  );

  return (
    <div style={{ fontFamily: "'Share Tech Mono', 'Courier New', monospace", background: "#0a0a0a", minHeight: "100vh", color: "#e0d5c0", maxWidth: 420, margin: "0 auto", boxShadow: "0 0 80px #000", display: "flex", flexDirection: "column" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Barlow+Condensed:wght@400;600;700;900&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: #111; } ::-webkit-scrollbar-thumb { background: #333; }
        select, button, input { outline: none; }
        select option { background: #111; color: #ddd; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes slideIn { from { transform: translateX(120%); } to { transform: translateX(0); } }
        @keyframes fadeUp { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .fade-up { animation: fadeUp 0.25s ease forwards; }
        button:active { transform: scale(0.97); }
      `}</style>

      {toast && <Toast msg={toast.msg} type={toast.type} />}

      {/* Status bar */}
      <div style={{ background: "#080808", borderBottom: "1px solid #1a1a1a", padding: "5px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 10, letterSpacing: 1 }}>
        <span style={{ color: "#444" }}>◉ BUS-POS v3.0</span>
        <span style={{ color: "#f0a500", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 13 }}>
          {clock.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
        <span style={{ color: "#444" }}>{dashboard?.bus ? `🚌 ${dashboard.bus.vehicle_number}` : "NO BUS"}</span>
      </div>

      {/* Header */}
      <div style={{ background: "#111", borderBottom: "2px solid #f0a500", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 22, fontWeight: 900, letterSpacing: 3, color: "#fff" }}>🚌 TransitPOS</div>
          <div style={{ fontSize: 9, color: "#555", letterSpacing: 2, marginTop: 1 }}>CONDUCTOR DASHBOARD</div>
        </div>
        <button onClick={onRefresh} disabled={refreshing} style={{ background: "#1a1a1a", border: "1px solid #333", color: "#f0a500", width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          {refreshing ? <Spinner size={14} /> : "↻"}
        </button>
      </div>

      {/* Nav */}
      <div style={{ display: "flex", background: "#0d0d0d", borderBottom: "1px solid #1a1a1a", flexShrink: 0 }}>
        {[{ id: "home", icon: "⬛", label: "HOME" }, { id: "sell", icon: "＋", label: "SELL" }, { id: "tickets", icon: "≡", label: "TICKETS" }, { id: "collection", icon: "₹", label: "REPORT" }].map((t) => (
          <button key={t.id} onClick={() => setScreen(t.id)} style={{ flex: 1, padding: "9px 4px", background: "none", borderBottom: `2px solid ${screen === t.id ? "#f0a500" : "transparent"}`, color: screen === t.id ? "#f0a500" : "#555", fontSize: 9, letterSpacing: 1.5, cursor: "pointer", fontFamily: "inherit", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, border: "none" }}>
            <span style={{ fontSize: 14 }}>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>

        {/* ─── HOME SCREEN ─── */}
        {screen === "home" && (
          <div className="fade-up">
            {/* Active Trip Card */}
            <Card accent={activeTrip ? (activeTrip.status === "running" ? "#4dbb6d" : "#f0a500") : "#333"} style={{ padding: activeTrip ? 14 : 0 }}>
              {activeTrip ? (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 9, color: "#666", letterSpacing: 2, marginBottom: 4 }}>ACTIVE TRIP</div>
                      <div style={{ fontSize: 16, color: "#fff", fontWeight: 700 }}>{activeTrip.route_name}</div>
                      <div style={{ fontSize: 10, color: "#555", marginTop: 3 }}>
                        Started {formatTime(activeTrip.start_time)} · {formatDuration(activeTrip.start_time, null)} · {activeTrip.direction}
                      </div>
                    </div>
                    <StatusBadge status={activeTrip.status} />
                  </div>

                  {/* Live stats */}
                  <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                    <div style={{ flex: 1, background: "#111", border: "1px solid #1a1a1a", padding: "10px", textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: "#f0a500", fontFamily: "'Barlow Condensed', sans-serif" }}>{activeTrip.tickets_sold}</div>
                      <div style={{ fontSize: 9, color: "#555", letterSpacing: 1 }}>TICKETS</div>
                    </div>
                    <div style={{ flex: 1, background: "#111", border: "1px solid #1a1a1a", padding: "10px", textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: "#6dba6d", fontFamily: "'Barlow Condensed', sans-serif" }}>₹{activeTrip.collection}</div>
                      <div style={{ fontSize: 9, color: "#555", letterSpacing: 1 }}>COLLECTED</div>
                    </div>
                  </div>

                  {/* Stage Filter */}
                  <StageFilter tripId={activeTrip.trip_id} baseTickets={activeTrip.tickets_sold} baseCollection={activeTrip.collection} />

                  {/* Actions */}
                  <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
                    {activeTrip.status === "running" && (
                      <ActionBtn label="PAUSE" icon="⏸" color="#f0a500" bg="#1a1200" onClick={() => changeStatus("paused")} disabled={statusChanging} />
                    )}
                    {activeTrip.status === "paused" && (
                      <ActionBtn label="RESUME" icon="▶" color="#6dba6d" bg="#0d2a12" onClick={() => changeStatus("running")} disabled={statusChanging} />
                    )}
                    <ActionBtn label="SELL" icon="🎟" color="#5ab4e0" bg="#0a1a2a" onClick={() => setShowSellTicket(true)} />
                    <ActionBtn label="PASSENGERS" icon="👥" color="#a070f0" bg="#1a0a2a" onClick={() => setPassengersTripId(activeTrip.trip_id)} />
                    <ActionBtn label="REPORT" icon="📊" color="#888" bg="#1a1a1a" onClick={() => setReportTripId(activeTrip.trip_id)} />
                    <ActionBtn label="END" icon="⏹" color="#d96" bg="#2a0a0a" onClick={() => changeStatus("completed")} disabled={statusChanging} loading={statusChanging} />
                  </div>
                </>
              ) : (
                <div style={{ padding: 24, textAlign: "center" }}>
                  <div style={{ fontSize: 40, marginBottom: 8 }}>🚌</div>
                  <div style={{ fontSize: 14, color: "#555", fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>NO ACTIVE TRIP</div>
                  <div style={{ fontSize: 11, color: "#333", marginBottom: 16 }}>Start a trip when you're ready to go</div>
                  <button onClick={() => setShowStartTrip(true)} style={{ background: "#f0a500", color: "#000", border: "none", padding: "12px 24px", fontSize: 12, letterSpacing: 2, fontFamily: "inherit", fontWeight: 700, cursor: "pointer" }}>▶ START TRIP</button>
                </div>
              )}
            </Card>

            {activeTrip && (
              <button onClick={() => setShowStartTrip(true)} style={{ width: "100%", padding: "9px", background: "transparent", border: "1px dashed #333", color: "#666", fontSize: 10, letterSpacing: 2, fontFamily: "inherit", cursor: "pointer", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                ＋ START ANOTHER TRIP
              </button>
            )}

            {/* Today Stats */}
            <Card>
              <SectionHeader title="TODAY'S STATS" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {[
                  { icon: "🚌", label: "TRIPS", value: stats.trips_completed ?? 0, color: "#a070f0" },
                  { icon: "🎟", label: "TICKETS", value: stats.tickets_sold ?? 0, color: "#f0a500" },
                  { icon: "👥", label: "PASSENGERS", value: stats.passengers ?? 0, color: "#5ab4e0" },
                  { icon: "₹", label: "COLLECTION", value: `₹${stats.total_collection ?? 0}`, color: "#6dba6d" },
                ].map((s) => (
                  <div key={s.label} style={{ background: "#111", border: "1px solid #1a1a1a", borderTop: `2px solid ${s.color}`, padding: "12px 14px" }}>
                    <div style={{ fontSize: 18, marginBottom: 4 }}>{s.icon}</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: s.color, fontFamily: "'Barlow Condensed', sans-serif" }}>{s.value}</div>
                    <div style={{ fontSize: 9, color: "#555", letterSpacing: 1, marginTop: 2 }}>{s.label}</div>
                  </div>
                ))}
              </div>
            </Card>

            {/* Recent Trips */}
            <Card>
              <SectionHeader title="RECENT TRIPS (24H)" right={<span style={{ fontSize: 10, color: "#f0a500" }}>{recentTrips.length} TRIPS</span>} />
              {recentTrips.length === 0 ? (
                <div style={{ textAlign: "center", padding: "20px 0", color: "#444", fontSize: 11 }}>NO TRIPS IN LAST 24H</div>
              ) : recentTrips.map((t, i) => (
                <div key={i} onClick={() => setReportTripId(t.trip_id)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #1a1a1a", cursor: "pointer" }}>
                  <div>
                    <div style={{ fontSize: 12, color: "#ddd" }}>{t.route_name}</div>
                    <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>{formatDate(t.start_time)} · {t.direction}{t.end_time ? ` · ${formatDuration(t.start_time, t.end_time)}` : ""}</div>
                    <div style={{ display: "flex", gap: 8, marginTop: 3 }}>
                      <span style={{ fontSize: 10, color: "#888" }}>🎟 {t.tickets_sold}</span>
                      <span style={{ fontSize: 10, color: "#6dba6d" }}>₹{t.collection}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                    <StatusBadge status={t.status} />
                    <span style={{ color: "#444", fontSize: 14 }}>›</span>
                  </div>
                </div>
              ))}
            </Card>
          </div>
        )}

        {/* ─── SELL SCREEN ─── */}
        {screen === "sell" && (
          <div className="fade-up">
            {!activeTrip ? (
              <Card>
                <div style={{ textAlign: "center", padding: 24 }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>⚠️</div>
                  <div style={{ color: "#d96", fontSize: 12, letterSpacing: 1, marginBottom: 12 }}>NO ACTIVE TRIP</div>
                  <div style={{ color: "#555", fontSize: 11, marginBottom: 16 }}>You need to start a trip before issuing tickets</div>
                  <button onClick={() => { setShowStartTrip(true); setScreen("home"); }} style={{ background: "#f0a500", color: "#000", border: "none", padding: "10px 20px", fontSize: 11, letterSpacing: 2, fontFamily: "inherit", fontWeight: 700, cursor: "pointer" }}>▶ START TRIP</button>
                </div>
              </Card>
            ) : (
              <>
                <Card accent="#f0a500">
                  <SectionHeader title="ACTIVE TRIP" />
                  <div style={{ fontSize: 14, color: "#fff", marginBottom: 4 }}>{activeTrip.route_name}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <StatusBadge status={activeTrip.status} />
                    <span style={{ fontSize: 10, color: "#555" }}>{activeTrip.tickets_sold} tickets · ₹{activeTrip.collection}</span>
                  </div>
                </Card>
                <button onClick={() => setShowSellTicket(true)} style={{ width: "100%", padding: "16px", background: "#f0a500", color: "#000", border: "none", fontSize: 14, letterSpacing: 2, fontFamily: "inherit", fontWeight: 900, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 12 }}>
                  🎟 ISSUE NEW TICKET
                </button>
              </>
            )}
          </div>
        )}

        {/* ─── TICKETS SCREEN ─── */}
        {screen === "tickets" && (
          <TicketsScreen
            activeTrip={activeTrip}
            onVerify={(ticketId) => {
              api.post(`/conductor/ticket/${ticketId}/verify`).then(() => {
                showToast("Ticket verified!");
              }).catch(() => showToast("Could not verify", "error"));
            }}
          />
        )}

        {/* ─── COLLECTION / REPORT SCREEN ─── */}
        {screen === "collection" && (
          <div className="fade-up">
            <Card>
              <SectionHeader title="COLLECTION SUMMARY" right={
                <div style={{ display: "flex", gap: 4 }}>
                  {["today", "week", "month"].map((p) => (
                    <PillBtn key={p} label={p.toUpperCase()} active={collectionPeriod === p} onClick={() => { setCollectionPeriod(p); fetchCollection(p); }} />
                  ))}
                </div>
              } />
              {collectionLoading ? (
                <div style={{ textAlign: "center", padding: 20 }}><Spinner /></div>
              ) : collection ? (
                <>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    {[
                      { label: "TOTAL", value: `₹${collection.total || 0}`, color: "#f0a500" },
                      { label: "TRIPS", value: collection.trips || 0, color: "#a070f0" },
                      { label: "TICKETS", value: collection.tickets || 0, color: "#5ab4e0" },
                    ].map((s) => (
                      <div key={s.label} style={{ flex: 1, background: "#111", border: "1px solid #1a1a1a", padding: "10px 8px", textAlign: "center" }}>
                        <div style={{ fontSize: 20, fontWeight: 800, color: s.color, fontFamily: "'Barlow Condensed', sans-serif" }}>{s.value}</div>
                        <div style={{ fontSize: 9, color: "#555", letterSpacing: 1 }}>{s.label}</div>
                      </div>
                    ))}
                  </div>
                  <MiniBarChart data={collection.daily || []} />
                </>
              ) : null}
            </Card>

            {/* Recent trips with report links */}
            <Card>
              <SectionHeader title="TRIP REPORTS" />
              {recentTrips.length === 0 && (
                <div style={{ textAlign: "center", padding: "20px 0", color: "#444", fontSize: 11 }}>NO RECENT TRIPS</div>
              )}
              {recentTrips.map((t, i) => (
                <div key={i} onClick={() => setReportTripId(t.trip_id)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #1a1a1a", cursor: "pointer" }}>
                  <div>
                    <div style={{ fontSize: 12, color: "#ddd" }}>{t.route_name}</div>
                    <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>{formatDate(t.start_time)} · {formatDuration(t.start_time, t.end_time)}</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 14, color: "#f0a500", fontWeight: 700 }}>₹{t.collection}</span>
                    <span style={{ color: "#f0a500" }}>›</span>
                  </div>
                </div>
              ))}
            </Card>
          </div>
        )}
      </div>

      {/* Bottom safe area */}
      <div style={{ background: "#080808", borderTop: "1px solid #1a1a1a", padding: "6px 16px", display: "flex", justifyContent: "space-between", fontSize: 9, color: "#2a2a2a", flexShrink: 0 }}>
        <span>DEPOT: CENTRAL</span>
        <span style={{ color: activeTrip ? "#4dbb6d" : "#555" }}>{activeTrip ? "● TRIP ACTIVE" : "○ NO TRIP"}</span>
        <span>v3.0.0</span>
      </div>

      {/* Modals */}
      {reportTripId && <TripReportModal tripId={reportTripId} onClose={() => setReportTripId(null)} />}
      {passengersTripId && <PassengersModal tripId={passengersTripId} onClose={() => setPassengersTripId(null)} />}
      {showStartTrip && <StartTripModal onClose={() => setShowStartTrip(false)} onStarted={() => { fetchDashboard(); fetchCollection(collectionPeriod); }} />}
      {showSellTicket && activeTrip && (
        <SellTicketModal trip={activeTrip} onClose={() => setShowSellTicket(false)} onIssued={() => { fetchDashboard(); }} showToast={showToast} />
      )}
    </div>
  );
}