import React, {useEffect, useState, useRef} from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Animated,
  StatusBar,
  SafeAreaView,
} from 'react-native';
import {Ticket, MapPin, Bus, Clock, Wifi, WifiOff} from 'lucide-react-native';
import {supabase} from '../../lib/supabase';

// ─── helpers ────────────────────────────────────────────────────────────────
const timeAgo = isoString => {
  const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
};

// ─── animated ticket card ────────────────────────────────────────────────────
const TicketCard = ({item, isNew, isLatest}) => {
  const fadeAnim = useRef(new Animated.Value(isNew ? 0 : 1)).current;
  const slideAnim = useRef(new Animated.Value(isNew ? -20 : 0)).current;
  const scaleAnim = useRef(new Animated.Value(isLatest ? 0.97 : 1)).current;

  useEffect(() => {
    if (isNew) {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 400,
          useNativeDriver: true,
        }),
        Animated.spring(scaleAnim, {
          toValue: 1,
          friction: 5,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, []);

  return (
    <Animated.View
      style={[
        styles.card,
        isLatest && styles.cardLatest,
        {
          opacity: fadeAnim,
          transform: [{translateY: slideAnim}, {scale: scaleAnim}],
        },
      ]}>
      {/* header row */}
      <View style={styles.cardHeader}>
        <View style={[styles.iconBadge, isLatest && styles.iconBadgeLatest]}>
          <Ticket
            size={14}
            color={isLatest ? '#0f172a' : '#0f172a'}
            strokeWidth={2.2}
          />
        </View>
        <Text
          style={[styles.ticketId, isLatest && styles.ticketIdLatest]}
          numberOfLines={1}>
          {item.id.slice(0, 8).toUpperCase()}
        </Text>
        {isLatest && (
          <View style={styles.latestBadge}>
            <Text style={styles.latestBadgeText}>LATEST</Text>
          </View>
        )}
        <View style={styles.timeRow}>
          <Clock
            size={11}
            color={isLatest ? '#94a3b8' : '#64748b'}
            strokeWidth={2}
          />
          <Text style={[styles.timeText, isLatest && styles.timeTextLatest]}>
            {timeAgo(item.created_at)}
          </Text>
        </View>
      </View>

      {/* divider */}
      <View style={[styles.divider, isLatest && styles.dividerLatest]} />

      {/* route */}
      <View style={styles.routeRow}>
        <View style={styles.routePoint}>
          <View style={[styles.dotFrom, isLatest && styles.dotFromLatest]} />
          <Text style={[styles.routeLabel, isLatest && styles.routeLabelLatest]}>
            FROM
          </Text>
          <Text style={[styles.routeValue, isLatest && styles.routeValueLatest]}>
            {item.from ?? '—'}
          </Text>
        </View>
        <View style={[styles.routeLine, isLatest && styles.routeLineLatest]} />
        <View style={[styles.routePoint, {alignItems: 'flex-end'}]}>
          <View style={[styles.dotTo, isLatest && styles.dotToLatest]} />
          <Text style={[styles.routeLabel, isLatest && styles.routeLabelLatest]}>
            TO
          </Text>
          <Text style={[styles.routeValue, isLatest && styles.routeValueLatest]}>
            {item.to ?? '—'}
          </Text>
        </View>
      </View>

      {/* footer */}
      <View style={styles.cardFooter}>
        <View style={[styles.metaChip, isLatest && styles.metaChipLatest]}>
          <Bus
            size={12}
            color={isLatest ? '#94a3b8' : '#64748b'}
            strokeWidth={2}
          />
          <Text style={[styles.metaText, isLatest && styles.metaTextLatest]}>
            {item.bus_id ? item.bus_id.slice(0, 8).toUpperCase() : 'No Bus'}
          </Text>
        </View>
        <View style={[styles.metaChip, isLatest && styles.metaChipLatest]}>
          <MapPin
            size={12}
            color={isLatest ? '#94a3b8' : '#64748b'}
            strokeWidth={2}
          />
          <Text style={[styles.metaText, isLatest && styles.metaTextLatest]}>
            {item.ticketed_at
              ? new Date(item.ticketed_at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : 'No time'}
          </Text>
        </View>
      </View>
    </Animated.View>
  );
};

// ─── main component ──────────────────────────────────────────────────────────
const VerificationTicketsFeed = () => {
  const [tickets, setTickets] = useState(/** @type {any[]} */ ([]));
  const [connected, setConnected] = useState(false);
  const [newIds, setNewIds] = useState(new Set());
  const [latestId, setLatestId] = useState(null);
  const pulsAnim = useRef(new Animated.Value(1)).current;

  const markAsLatest = id => {
    setLatestId(id);
    setNewIds(prev => new Set(prev).add(id));
    setTimeout(() => {
      setNewIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 3000);
  };

  // pulse the dot while connected
  useEffect(() => {
    if (!connected) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulsAnim, {
          toValue: 0.3,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(pulsAnim, {
          toValue: 1,
          duration: 900,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [connected]);

  useEffect(() => {
    // fetch existing rows on mount
    const fetchInitial = async () => {
      const {data, error} = await supabase
        .from('verification_tickets')
        .select('*')
        .order('created_at', {ascending: false})
        .limit(30);
      if (!error && data) setTickets(data);
    };
    fetchInitial();

    // realtime subscription
    const channel = supabase
      .channel('verification_tickets_feed')
      .on(
        'postgres_changes',
        {event: 'INSERT', schema: 'public', table: 'verification_tickets'},
        payload => {
          const newTicket = payload.new;
          setTickets(prev => [newTicket, ...prev]);
          markAsLatest(newTicket.id);
        },
      )
      .on(
        'postgres_changes',
        {event: 'UPDATE', schema: 'public', table: 'verification_tickets'},
        payload => {
          const updated = payload.new;
          setTickets(prev => {
            const filtered = prev.filter(t => t.id !== updated.id);
            return [updated, ...filtered];
          });
          markAsLatest(updated.id);
        },
      )
      .on(
        'postgres_changes',
        {event: 'DELETE', schema: 'public', table: 'verification_tickets'},
        payload => {
          setTickets(prev => prev.filter(t => t.id !== payload.old.id));
          setLatestId(prev => (prev === payload.old.id ? null : prev));
        },
      )
      .subscribe(status => {
        setConnected(status === 'SUBSCRIBED');
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor="#0f172a" />

      {/* ── header ── */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Live Tickets</Text>
          <Text style={styles.headerSub}>
            {tickets.length} ticket{tickets.length !== 1 ? 's' : ''} loaded
          </Text>
        </View>
        <View style={styles.statusChip}>
          {connected ? (
            <Animated.View style={[styles.statusDot, {opacity: pulsAnim}]} />
          ) : (
            <View style={[styles.statusDot, styles.statusDotOff]} />
          )}
          {connected ? (
            <Wifi size={13} color="#e2e8f0" strokeWidth={2} />
          ) : (
            <WifiOff size={13} color="#64748b" strokeWidth={2} />
          )}
          <Text style={[styles.statusText, !connected && styles.statusTextOff]}>
            {connected ? 'Live' : 'Connecting…'}
          </Text>
        </View>
      </View>

      {/* ── feed ── */}
      <FlatList
        data={tickets}
        keyExtractor={item => item.id}
        renderItem={({item}) => (
          <TicketCard
            item={item}
            isNew={newIds.has(item.id)}
            isLatest={latestId === item.id}
          />
        )}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ticket size={32} color="#334155" strokeWidth={1.5} />
            <Text style={styles.emptyText}>Waiting for tickets…</Text>
          </View>
        }
      />
    </SafeAreaView>
  );
};

// ─── styles ──────────────────────────────────────────────────────────────────
const COLORS = {
  bg: '#0f172a',
  surface: '#1e293b',
  border: '#334155',
  accent: '#e2e8f0',
  muted: '#64748b',
  accentPop: '#f8fafc',
  // latest highlight — a single accent tone, no rainbow
  latestSurface: '#1e3a5f',
  latestBorder: '#3b82f6',
  latestText: '#93c5fd',
  latestPop: '#dbeafe',
};

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: COLORS.bg},

  // header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.accentPop,
    letterSpacing: 0.3,
  },
  headerSub: {fontSize: 12, color: COLORS.muted, marginTop: 2},

  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: COLORS.surface,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#22c55e',
  },
  statusDotOff: {backgroundColor: COLORS.muted},
  statusText: {fontSize: 12, color: COLORS.accent, fontWeight: '600'},
  statusTextOff: {color: COLORS.muted},

  // list
  list: {paddingHorizontal: 16, paddingTop: 14, paddingBottom: 30},

  // card — base
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  // card — latest override
  cardLatest: {
    backgroundColor: COLORS.latestSurface,
    borderColor: COLORS.latestBorder,
    borderWidth: 1.5,
    shadowColor: COLORS.latestBorder,
    shadowOffset: {width: 0, height: 0},
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 6,
  },

  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconBadge: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBadgeLatest: {
    backgroundColor: COLORS.latestText,
  },

  ticketId: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.accentPop,
    letterSpacing: 0.8,
    fontVariant: ['tabular-nums'],
  },
  ticketIdLatest: {
    fontSize: 15,
    color: COLORS.latestPop,
    letterSpacing: 1,
  },

  latestBadge: {
    backgroundColor: COLORS.latestBorder,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    marginRight: 4,
  },
  latestBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: 0.8,
  },

  timeRow: {flexDirection: 'row', alignItems: 'center', gap: 4},
  timeText: {fontSize: 11, color: COLORS.muted},
  timeTextLatest: {color: '#94a3b8'},

  divider: {
    height: 1,
    backgroundColor: COLORS.border,
    marginVertical: 12,
  },
  dividerLatest: {
    backgroundColor: COLORS.latestBorder,
    opacity: 0.4,
  },

  // route
  routeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  routePoint: {flex: 1},
  dotFrom: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.accent,
    marginBottom: 4,
  },
  dotFromLatest: {
    backgroundColor: COLORS.latestPop,
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  dotTo: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.muted,
    marginBottom: 4,
    alignSelf: 'flex-end',
  },
  dotToLatest: {
    backgroundColor: COLORS.latestText,
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  routeLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: COLORS.muted,
    letterSpacing: 1,
    marginBottom: 2,
  },
  routeLabelLatest: {
    color: COLORS.latestText,
  },
  routeValue: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.accentPop,
  },
  routeValueLatest: {
    fontSize: 17,
    fontWeight: '800',
    color: COLORS.latestPop,
  },
  routeLine: {
    flex: 0.4,
    height: 1,
    backgroundColor: COLORS.border,
    marginHorizontal: 8,
    marginTop: 8,
  },
  routeLineLatest: {
    backgroundColor: COLORS.latestBorder,
    opacity: 0.5,
  },

  // footer
  cardFooter: {
    flexDirection: 'row',
    gap: 8,
  },
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: COLORS.bg,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  metaChipLatest: {
    backgroundColor: '#0f2744',
    borderColor: COLORS.latestBorder,
    opacity: 0.9,
  },
  metaText: {fontSize: 11, color: COLORS.muted, fontWeight: '500'},
  metaTextLatest: {color: '#94a3b8', fontWeight: '600'},

  // empty
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    gap: 12,
  },
  emptyText: {fontSize: 14, color: COLORS.muted},
});

export default VerificationTicketsFeed;