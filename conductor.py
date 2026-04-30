import traceback
import uuid
from datetime import datetime, date, timedelta

from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from sqlalchemy import text

conductor_bp = Blueprint("conductor", __name__)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────
def _db():
    from .models import db
    return db

def _user_model():
    from .models import User
    return User

def get_conductor_or_403():
    User = _user_model()
    uid  = get_jwt_identity()
    user = User.query.get(uid)
    if not user or user.role not in ("conductor", "admin", "bus_owner", "app_admin"):
        return None, (jsonify({"error": "Unauthorized"}), 403)
    return user, None


# ─────────────────────────────────────────────────────────────────────────────
# GET /conductor/dashboard
# ─────────────────────────────────────────────────────────────────────────────
@conductor_bp.route("/conductor/dashboard", methods=["GET"])
@jwt_required()
def conductor_dashboard():
    try:
        db = _db()
        conductor, err = get_conductor_or_403()
        if err:
            return err

        cid = str(conductor.id)

        active_row = db.session.execute(text("""
            SELECT t.id, t.bus_id, t.route_id, t.conductor_id, t.direction,
                   t.start_time, t.expected_end_time, t.status, t.trip_number,
                   r.route_name
            FROM trips t
            LEFT JOIN routes r ON r.id = t.route_id
            WHERE t.conductor_id = :cid
              AND t.status IN ('scheduled', 'running', 'paused')
            ORDER BY t.start_time DESC
            LIMIT 1
        """), {"cid": cid}).fetchone()

        active_trip_data = None
        if active_row:
            ts = db.session.execute(text("""
                SELECT COUNT(*) AS cnt,
                       COALESCE(SUM(COALESCE(fare, 0)), 0) AS total
                FROM tickets WHERE trip_id = :tid
            """), {"tid": str(active_row.id)}).fetchone()
            end = active_row.expected_end_time
            active_trip_data = {
                "trip_id":      str(active_row.id),
                "trip_number":  active_row.trip_number,
                "route_id":     str(active_row.route_id) if active_row.route_id else None,
                "route_name":   active_row.route_name or "Unknown",
                "direction":    active_row.direction,
                "status":       active_row.status,
                "start_time":   active_row.start_time.isoformat() if active_row.start_time else None,
                "end_time":     end.isoformat() if end else None,
                "bus_id":       str(active_row.bus_id) if active_row.bus_id else None,
                "tickets_sold": int(ts.cnt)   if ts else 0,
                "collection":   round(float(ts.total), 2) if ts else 0.0,
            }

        today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)

        s = db.session.execute(text("""
            SELECT
                COUNT(DISTINCT t.id)                                                    AS trip_count,
                COALESCE(COUNT(tk.id), 0)                                               AS ticket_count,
                COALESCE(SUM(COALESCE(tk.fare, 0)), 0)                                  AS total_collection,
                COALESCE(SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END), 0)   AS completed_count
            FROM trips t
            LEFT JOIN tickets tk ON tk.trip_id = t.id
            WHERE t.conductor_id = :cid
              AND t.start_time >= :today
        """), {"cid": cid, "today": today_start}).fetchone()

        since_24h = datetime.utcnow() - timedelta(hours=24)

        recent_rows = db.session.execute(text("""
            SELECT t.id, t.bus_id, t.route_id, t.direction,
                   t.start_time, t.expected_end_time, t.status, t.trip_number,
                   r.route_name,
                   COUNT(tk.id)                             AS ticket_count,
                   COALESCE(SUM(COALESCE(tk.fare, 0)), 0)  AS collection
            FROM trips t
            LEFT JOIN routes  r  ON r.id = t.route_id
            LEFT JOIN tickets tk ON tk.trip_id = t.id
            WHERE t.conductor_id = :cid
              AND t.start_time >= :since_24h
            GROUP BY t.id, r.route_name
            ORDER BY t.start_time DESC
            LIMIT 10
        """), {"cid": cid, "since_24h": since_24h}).fetchall()

        bus_info   = None
        ref_bus_id = (active_row.bus_id if active_row
                      else (recent_rows[0].bus_id if recent_rows else None))
        if ref_bus_id:
            br = db.session.execute(text("""
                SELECT id, bus_number, bus_name, capacity FROM buses WHERE id = :bid
            """), {"bid": str(ref_bus_id)}).fetchone()
            if br:
                bus_info = {
                    "id":             str(br.id),
                    "vehicle_number": br.bus_number,
                    "bus_name":       br.bus_name,
                    "capacity":       br.capacity,
                }

        def fmt(r):
            end = r.expected_end_time
            return {
                "trip_id":      str(r.id),
                "trip_number":  getattr(r, "trip_number", None),
                "route_name":   r.route_name or "Unknown",
                "direction":    r.direction,
                "status":       r.status,
                "start_time":   r.start_time.isoformat() if r.start_time else None,
                "end_time":     end.isoformat() if end else None,
                "bus_id":       str(r.bus_id) if r.bus_id else None,
                "tickets_sold": int(r.ticket_count or 0),
                "collection":   round(float(r.collection or 0), 2),
            }

        return jsonify({
            "conductor": {
                "id":    cid,
                "name":  conductor.username or getattr(conductor, "name", None),
                "email": conductor.email,
            },
            "bus":         bus_info,
            "active_trip": active_trip_data,
            "today_stats": {
                "trips_completed":  int(s.trip_count or 0)                   if s else 0,
                "tickets_sold":     int(s.ticket_count or 0)                  if s else 0,
                "total_collection": round(float(s.total_collection or 0), 2)  if s else 0.0,
                "passengers":       int(s.ticket_count or 0)                  if s else 0,
            },
            "recent_trips": [fmt(r) for r in recent_rows],
        }), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# GET /conductor/collection/summary?period=today|week|month
# ─────────────────────────────────────────────────────────────────────────────
@conductor_bp.route("/conductor/collection/summary", methods=["GET"])
@jwt_required()
def collection_summary():
    try:
        db = _db()
        conductor, err = get_conductor_or_403()
        if err:
            return err

        cid    = str(conductor.id)
        period = request.args.get("period", "today")
        now    = datetime.utcnow()

        if period == "week":
            start = datetime.combine((now - timedelta(days=6)).date(), datetime.min.time())
        elif period == "month":
            start = datetime(now.year, now.month, 1)
        else:
            start = datetime.combine(now.date(), datetime.min.time())

        daily_rows = db.session.execute(text("""
            SELECT
                DATE(tk.created_at)                          AS day,
                COUNT(tk.id)                                 AS tickets,
                COALESCE(SUM(COALESCE(tk.fare, 0)), 0)       AS collection
            FROM tickets tk
            JOIN trips t ON t.id = tk.trip_id
            WHERE t.conductor_id = :cid AND t.start_time >= :start
            GROUP BY DATE(tk.created_at)
            ORDER BY day ASC
        """), {"cid": cid, "start": start}).fetchall()

        totals = db.session.execute(text("""
            SELECT
                COUNT(DISTINCT t.id)                         AS trip_count,
                COUNT(tk.id)                                 AS ticket_count,
                COALESCE(SUM(COALESCE(tk.fare, 0)), 0)       AS total
            FROM trips t
            LEFT JOIN tickets tk ON tk.trip_id = t.id
            WHERE t.conductor_id = :cid AND t.start_time >= :start
        """), {"cid": cid, "start": start}).fetchone()

        return jsonify({
            "period":  period,
            "daily": [
                {
                    "date":       str(r.day),
                    "tickets":    int(r.tickets or 0),
                    "collection": round(float(r.collection or 0), 2),
                }
                for r in daily_rows
            ],
            "total":   round(float(totals.total or 0), 2)   if totals else 0.0,
            "trips":   int(totals.trip_count or 0)           if totals else 0,
            "tickets": int(totals.ticket_count or 0)         if totals else 0,
        }), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# POST /conductor/trip/start  — pure raw SQL, no Trip model needed
# ─────────────────────────────────────────────────────────────────────────────
@conductor_bp.route("/conductor/trip/start", methods=["POST"])
@jwt_required()
def start_trip():
    try:
        db = _db()
        conductor, err = get_conductor_or_403()
        if err:
            return err

        cid = str(conductor.id)

        existing = db.session.execute(text("""
            SELECT id FROM trips
            WHERE conductor_id = :cid
              AND status IN ('scheduled','running','paused')
            LIMIT 1
        """), {"cid": cid}).fetchone()

        if existing:
            return jsonify({
                "error":   "You already have an active trip",
                "trip_id": str(existing.id),
            }), 409

        data     = request.json or {}
        route_id = data.get("route_id")
        bus_id   = data.get("bus_id")

        # Normalize direction: accept 'forward'/'return' (old) and 'up'/'dn' (new)
        _dir = str(data.get("direction", "up")).lower().strip()
        direction = {"forward": "up", "up": "up", "return": "dn", "dn": "dn"}.get(_dir)
        if not direction:
            return jsonify({"error": "Invalid direction. Use 'up' or 'dn'"}), 400

        # Fall back to last known bus if not provided
        if not bus_id:
            last = db.session.execute(text("""
                SELECT bus_id FROM trips
                WHERE conductor_id = :cid AND bus_id IS NOT NULL
                ORDER BY start_time DESC LIMIT 1
            """), {"cid": cid}).fetchone()
            bus_id = str(last.bus_id) if last else None

        trip_id    = str(uuid.uuid4())
        start_time = datetime.utcnow()

        db.session.execute(text("""
            INSERT INTO trips (id, bus_id, route_id, conductor_id, direction, status, start_time)
            VALUES (:id, :bus_id, :route_id, :conductor_id, :direction, 'running', :start_time)
        """), {
            "id":           trip_id,
            "bus_id":       bus_id,
            "route_id":     route_id,
            "conductor_id": cid,
            "direction":    direction,
            "start_time":   start_time,
        })
        db.session.commit()

        return jsonify({
            "success":    True,
            "trip_id":    trip_id,
            "status":     "running",
            "start_time": start_time.isoformat(),
        }), 201

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# POST /conductor/trip/<trip_id>/status
# ─────────────────────────────────────────────────────────────────────────────
@conductor_bp.route("/conductor/trip/<trip_id>/status", methods=["POST"])
@jwt_required()
def change_trip_status(trip_id):
    try:
        db = _db()
        conductor, err = get_conductor_or_403()
        if err:
            return err

        row = db.session.execute(text("""
            SELECT id, conductor_id, status FROM trips WHERE id = :tid
        """), {"tid": trip_id}).fetchone()

        if not row:
            return jsonify({"error": "Trip not found"}), 404
        if str(row.conductor_id) != str(conductor.id) and conductor.role != "admin":
            return jsonify({"error": "Unauthorized"}), 403

        data       = request.json or {}
        new_status = data.get("status")
        VALID = {
            "scheduled": ["running", "completed"],
            "running":   ["paused",  "completed"],
            "paused":    ["running", "completed"],
        }
        if row.status not in VALID:
            return jsonify({"error": f"Cannot change from '{row.status}'"}), 400
        if new_status not in VALID.get(row.status, []):
            return jsonify({
                "error":   f"Invalid: '{row.status}' → '{new_status}'",
                "allowed": VALID[row.status],
            }), 400

        if new_status == "completed":
            db.session.execute(text("""
                UPDATE trips SET status=:s, expected_end_time=:now WHERE id=:tid
            """), {"s": new_status, "now": datetime.utcnow(), "tid": trip_id})
        else:
            db.session.execute(text("""
                UPDATE trips SET status=:s WHERE id=:tid
            """), {"s": new_status, "tid": trip_id})

        db.session.commit()
        return jsonify({"success": True, "trip_id": trip_id, "status": new_status}), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# GET /conductor/trip/<trip_id>/report
# ─────────────────────────────────────────────────────────────────────────────
@conductor_bp.route("/conductor/trip/<trip_id>/report", methods=["GET"])
@jwt_required()
def trip_report(trip_id):
    try:
        db = _db()
        conductor, err = get_conductor_or_403()
        if err:
            return err

        trip_row = db.session.execute(text("""
            SELECT t.id, t.conductor_id, t.direction, t.status,
                   t.start_time, t.expected_end_time, r.route_name
            FROM trips t
            LEFT JOIN routes r ON r.id = t.route_id
            WHERE t.id = :tid
        """), {"tid": trip_id}).fetchone()

        if not trip_row:
            return jsonify({"error": "Trip not found"}), 404
        if str(trip_row.conductor_id) != str(conductor.id) and conductor.role != "admin":
            return jsonify({"error": "Unauthorized"}), 403

        tickets = db.session.execute(text("""
            SELECT
                tk.id,
                COALESCE(tk.fare, 0)                     AS fare,
                tk.ticket_count,
                tk.is_verified,
                tk.payment_method,
                tk.created_at,
                COALESCE(fs.stop_name, 'Unknown')        AS from_name,
                COALESCE(ts.stop_name, 'Unknown')        AS to_name
            FROM tickets tk
            LEFT JOIN stops fs ON fs.id = tk.from_stop_id
            LEFT JOIN stops ts ON ts.id = tk.to_stop_id
            WHERE tk.trip_id = :tid
            ORDER BY tk.created_at DESC
        """), {"tid": trip_id}).fetchall()

        grouped = {}
        for t in tickets:
            key = f"{t.from_name}|||{t.to_name}"
            if key not in grouped:
                grouped[key] = {
                    "from":       t.from_name,
                    "to":         t.to_name,
                    "count":      0,
                    "full_count": 0,
                    "half_count": 0,
                    "free_count": 0,
                    "total_fare": 0.0,
                }
            g = grouped[key]
            g["count"]      += 1
            g["total_fare"] += float(t.fare or 0)

            pm = (t.payment_method or "").lower()
            if pm == "fr":
                g["free_count"] += 1
            elif pm == "half":
                g["half_count"] += 1
            else:
                g["full_count"] += 1

        route_breakdown = sorted(grouped.values(), key=lambda x: -x["total_fare"])

        total_collection = sum(float(t.fare or 0) for t in tickets)
        total_full       = sum(g["full_count"] for g in route_breakdown)
        total_half       = sum(g["half_count"] for g in route_breakdown)
        total_free       = sum(g["free_count"] for g in route_breakdown)
        total_verified   = sum(1 for t in tickets if t.is_verified)

        end = trip_row.expected_end_time

        return jsonify({
            "trip_id":    trip_id,
            "route_name": trip_row.route_name or "Unknown",
            "direction":  trip_row.direction,
            "status":     trip_row.status,
            "start_time": trip_row.start_time.isoformat() if trip_row.start_time else None,
            "end_time":   end.isoformat() if end else None,

            "summary": {
                "total_tickets":    len(tickets),
                "total_collection": round(total_collection, 2),
                "total_full":       total_full,
                "total_half":       total_half,
                "total_free":       total_free,
                "verified":         total_verified,
                "surrendered":      0,
            },

            "route_breakdown": [
                {
                    "from":       g["from"],
                    "to":         g["to"],
                    "route":      f"{g['from']} → {g['to']}",
                    "count":      g["count"],
                    "full_count": g["full_count"],
                    "half_count": g["half_count"],
                    "free_count": g["free_count"],
                    "revenue":    round(g["total_fare"], 2),
                    "total_fare": round(g["total_fare"], 2),
                }
                for g in route_breakdown
            ],

            "tickets": [
                {
                    "ticket_id":   str(t.id),
                    "from":        t.from_name,
                    "to":          t.to_name,
                    "fare":        float(t.fare or 0),
                    "is_verified": t.is_verified,
                    "is_free":     (t.payment_method or "").lower() == "fr",
                    "created_at":  t.created_at.isoformat() if t.created_at else None,
                }
                for t in tickets
            ],
        }), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# GET /conductor/trip/<trip_id>/stages
# ─────────────────────────────────────────────────────────────────────────────

@conductor_bp.route("/conductor/trip/<trip_id>/stages", methods=["GET"])
@jwt_required()
def trip_stages(trip_id):
    try:
        db = _db()
        conductor, err = get_conductor_or_403()
        if err:
            return err

        trip = db.session.execute(text("""
            SELECT route_id, conductor_id
            FROM trips
            WHERE id = :tid
        """), {"tid": trip_id}).fetchone()

        if not trip:
            return jsonify({"error": "Trip not found"}), 404

        if str(trip.conductor_id) != str(conductor.id) and conductor.role != "admin":
            return jsonify({"error": "Unauthorized"}), 403

        stops = db.session.execute(text("""
            SELECT
                id,
                stop_name,
                stop_order
            FROM stops
            WHERE route_id = :rid
            ORDER BY stop_order ASC
        """), {"rid": trip.route_id}).fetchall()

        return jsonify({
            "stops": [
                {
                    "id": str(s.id),
                    "name": s.stop_name,
                    "order": s.stop_order
                }
                for s in stops
            ]
        }), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# GET /conductor/trip/<trip_id>/stage-collection?from_stop=X&to_stop=Y
# ─────────────────────────────────────────────────────────────────────────────
@conductor_bp.route("/conductor/trip/<trip_id>/stage-collection", methods=["GET"])
@jwt_required()
def stage_collection(trip_id):
    try:
        db = _db()
        conductor, err = get_conductor_or_403()
        if err:
            return err

        # Get trip info
        trip = db.session.execute(text("""
            SELECT route_id, conductor_id, direction
            FROM trips
            WHERE id = :tid
        """), {"tid": trip_id}).fetchone()

        if not trip:
            return jsonify({"error": "Trip not found"}), 404

        if str(trip.conductor_id) != str(conductor.id) and conductor.role != "admin":
            return jsonify({"error": "Unauthorized"}), 403

        from_stop_id = request.args.get("from_stop")
        to_stop_id   = request.args.get("to_stop")

        from_order = None
        to_order   = None

        # Get stop orders
        if from_stop_id:
            fr = db.session.execute(text("""
                SELECT stop_order
                FROM stops
                WHERE id = :id
            """), {"id": from_stop_id}).fetchone()

            if fr:
                from_order = fr.stop_order

        if to_stop_id:
            tr = db.session.execute(text("""
                SELECT stop_order
                FROM stops
                WHERE id = :id
            """), {"id": to_stop_id}).fetchone()

            if tr:
                to_order = tr.stop_order

        # Base query
        query = """
        SELECT
            tk.id,
            COALESCE(tk.fare,0) AS fare,
            tk.ticket_count,
            tk.is_verified,
            tk.payment_method,
            tk.created_at,
            fs.stop_name AS from_name,
            ts.stop_name AS to_name,
            fs.stop_order AS from_order,
            ts.stop_order AS to_order
        FROM tickets tk
        LEFT JOIN stops fs ON fs.id = tk.from_stop_id
        LEFT JOIN stops ts ON ts.id = tk.to_stop_id
        WHERE tk.trip_id = :tid
        """

        params = {"tid": trip_id}

        # Apply stage filtering depending on direction
        if from_order is not None and to_order is not None:

            if trip.direction == "up":

                if from_order >= to_order:
                    return jsonify({
                        "error": "Invalid stage selection for UP trip"
                    }), 400

                query += """
                AND fs.stop_order >= :from_order
                AND ts.stop_order <= :to_order
                """

            else:  # DN trip

                if from_order <= to_order:
                    return jsonify({
                        "error": "Invalid stage selection for DN trip"
                    }), 400

                query += """
                AND fs.stop_order <= :from_order
                AND ts.stop_order >= :to_order
                """

            params["from_order"] = from_order
            params["to_order"]   = to_order

        query += " ORDER BY tk.created_at DESC"

        tickets = db.session.execute(text(query), params).fetchall()

        # Group tickets by route
        grouped = {}

        for t in tickets:

            key = f"{t.from_name}|||{t.to_name}"

            if key not in grouped:
                grouped[key] = {
                    "from": t.from_name,
                    "to": t.to_name,
                    "full_count": 0,
                    "half_count": 0,
                    "free_count": 0,
                    "total_fare": 0.0
                }

            g = grouped[key]

            g["total_fare"] += float(t.fare or 0)

            pm = (t.payment_method or "").lower()

            if pm == "fr":
                g["free_count"] += 1
            elif pm == "half":
                g["half_count"] += 1
            else:
                g["full_count"] += 1

        total_collection = sum(float(t.fare or 0) for t in tickets)
        total_full = sum(g["full_count"] for g in grouped.values())
        total_half = sum(g["half_count"] for g in grouped.values())
        total_free = sum(g["free_count"] for g in grouped.values())

        return jsonify({

            "trip_id": trip_id,

            "summary": {
                "total_tickets": len(tickets),
                "total_collection": round(total_collection,2),
                "total_full": total_full,
                "total_half": total_half,
                "total_free": total_free
            },

            "route_breakdown": [

                {
                    "from": g["from"],
                    "to": g["to"],
                    "route": f"{g['from']} → {g['to']}",
                    "full_count": g["full_count"],
                    "half_count": g["half_count"],
                    "free_count": g["free_count"],
                    "revenue": round(g["total_fare"],2),
                    "total_fare": round(g["total_fare"],2)
                }

                for g in sorted(grouped.values(),
                key=lambda x: -x["total_fare"])

            ],

            "tickets": [

                {
                    "ticket_id": str(t.id),
                    "from": t.from_name,
                    "to": t.to_name,
                    "fare": float(t.fare or 0),
                    "is_verified": t.is_verified,
                    "is_free": (t.payment_method or "").lower() == "fr",
                    "created_at": t.created_at.isoformat() if t.created_at else None
                }

                for t in tickets

            ]

        }), 200


    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
# ─────────────────────────────────────────────────────────────────────────────
# GET /conductor/passengers/<trip_id>
# ─────────────────────────────────────────────────────────────────────────────
@conductor_bp.route("/conductor/passengers/<trip_id>", methods=["GET"])
@jwt_required()
def trip_passengers(trip_id):
    try:
        db = _db()
        conductor, err = get_conductor_or_403()
        if err:
            return err

        trip_row = db.session.execute(text("""
            SELECT id, conductor_id FROM trips WHERE id = :tid
        """), {"tid": trip_id}).fetchone()

        if not trip_row:
            return jsonify({"error": "Trip not found"}), 404
        if str(trip_row.conductor_id) != str(conductor.id) and conductor.role != "admin":
            return jsonify({"error": "Unauthorized"}), 403

        tickets = db.session.execute(text("""
            SELECT
                tk.id,
                tk.user_id,
                COALESCE(tk.fare, 0)                     AS amount,
                tk.ticket_count,
                tk.is_verified,
                tk.payment_method,
                tk.created_at,
                COALESCE(fs.stop_name, 'Unknown')        AS from_name,
                COALESCE(ts.stop_name, 'Unknown')        AS to_name
            FROM tickets tk
            LEFT JOIN stops fs ON fs.id = tk.from_stop_id
            LEFT JOIN stops ts ON ts.id = tk.to_stop_id
            WHERE tk.trip_id = :tid
            ORDER BY tk.created_at DESC
        """), {"tid": trip_id}).fetchall()

        return jsonify({
            "trip_id":         trip_id,
            "passenger_count": len(tickets),
            "passengers": [
                {
                    "ticket_id":    str(t.id),
                    "from":         t.from_name,
                    "to":           t.to_name,
                    "amount":       float(t.amount or 0),
                    "ticket_count": int(t.ticket_count or 1),
                    "is_verified":  t.is_verified,
                    "is_free":      (t.payment_method or "").lower() == "fr",
                    "user_id":      str(t.user_id) if t.user_id else None,
                    "boarded_at":   t.created_at.isoformat() if t.created_at else None,
                }
                for t in tickets
            ],
        }), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# POST /conductor/ticket/<ticket_id>/verify
# ─────────────────────────────────────────────────────────────────────────────
@conductor_bp.route("/conductor/ticket/<ticket_id>/verify", methods=["POST"])
@jwt_required()
def verify_ticket(ticket_id):
    try:
        db = _db()
        conductor, err = get_conductor_or_403()
        if err:
            return err

        row = db.session.execute(text("""
            SELECT tk.id, t.conductor_id
            FROM tickets tk
            JOIN trips t ON t.id = tk.trip_id
            WHERE tk.id = :tkid
        """), {"tkid": ticket_id}).fetchone()

        if not row:
            return jsonify({"error": "Ticket not found"}), 404
        if str(row.conductor_id) != str(conductor.id) and conductor.role != "admin":
            return jsonify({"error": "Unauthorized"}), 403

        db.session.execute(text("""
            UPDATE tickets SET is_verified = true WHERE id = :tkid
        """), {"tkid": ticket_id})
        db.session.commit()

        return jsonify({"success": True, "ticket_id": ticket_id, "is_verified": True}), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# GET /conductor/routes
# ─────────────────────────────────────────────────────────────────────────────
@conductor_bp.route("/conductor/routes", methods=["GET"])
@jwt_required()
def conductor_routes():
    try:
        db = _db()
        conductor, err = get_conductor_or_403()
        if err:
            return err

        rows = db.session.execute(text("""
            SELECT id, route_name, source, destination, distance_km
            FROM routes ORDER BY route_name
        """)).fetchall()

        return jsonify({
            "routes": [
                {
                    "id":          str(r.id),
                    "name":        r.route_name,
                    "source":      r.source,
                    "destination": r.destination,
                    "distance_km": float(r.distance_km) if r.distance_km else None,
                }
                for r in rows
            ]
        }), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# GET /conductor/buses
# ─────────────────────────────────────────────────────────────────────────────
@conductor_bp.route("/conductor/buses", methods=["GET"])
@jwt_required()
def conductor_buses():
    try:
        db = _db()
        conductor, err = get_conductor_or_403()
        if err:
            return err

        rows = db.session.execute(text("""
            SELECT id, bus_number, bus_name, capacity
            FROM buses WHERE is_active = true
            ORDER BY bus_number
        """)).fetchall()

        return jsonify({
            "buses": [
                {
                    "id":         str(r.id),
                    "bus_number": r.bus_number,
                    "bus_name":   r.bus_name,
                    "capacity":   r.capacity,
                }
                for r in rows
            ]
        }), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500