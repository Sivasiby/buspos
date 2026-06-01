import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { fetchAllTickets, deleteTicket } from '../local_db/ticketActions';
import { database } from '../local_db/index';

const TICKET_TYPES = ['full', 'half'];
const DIRECTIONS   = ['up', 'dn'];
const TYPE_COLOR   = { full: '#6366f1', half: '#f59e0b' };
const DIR_COLOR    = { up: '#22c55e', dn: '#3b82f6' };
const genId = () => `pos_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const EMPTY_FORM = {
  fromStop: 'TestFrom', toStop: 'TestTo',
  fromKey: 'A',        toKey:  'B',
  ticketCount: '1',    fare: '50',  unitFare: '50',
  ticketType: 'full',  direction: 'up',
  busNumber: 'TEST-01', tripNumber: '1',
  luggageAmount: '0',
};

export default function TestScreen() {
  const [tickets, setTickets]       = useState([]);
  const [form, setForm]             = useState(EMPTY_FORM);
  const [editTarget, setEditTarget] = useState(null);
  const [editForm, setEditForm]     = useState(EMPTY_FORM);
  const [loading, setLoading]       = useState(false);

  const reload = useCallback(async () => {
    const all = await fetchAllTickets();
    setTickets(all);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const handleCreate = async () => {
    setLoading(true);
    try {
      await database.write(async () => {
        await database.get('tickets').create(row => {
          row.localId       = genId();
          row.tripId        = null;
          row.fromStop      = form.fromStop;
          row.toStop        = form.toStop;
          row.fromKey       = form.fromKey;
          row.toKey         = form.toKey;
          row.ticketCount   = Number(form.ticketCount) || 1;
          row.fare          = Number(form.fare) || 0;
          row.unitFare      = Number(form.unitFare) || 0;
          row.ticketType    = form.ticketType;
          row.luggageAmount = Number(form.luggageAmount) || 0;
          row.ticketNumber  = null;
          row.busNumber     = form.busNumber;
          row.tripNumber    = Number(form.tripNumber) || null;
          row.direction     = form.direction;
          row.issuedAt      = new Date().toISOString();
          row.synced        = false;
        });
      });
      setForm(EMPTY_FORM);
      await reload();
    } catch (e) {
      Alert.alert('Create failed', e.message);
    } finally {
      setLoading(false);
    }
  };

  const openEdit = ticket => {
    setEditTarget(ticket);
    setEditForm({
      fromStop:     ticket.fromStop     ?? '',
      toStop:       ticket.toStop       ?? '',
      fromKey:      ticket.fromKey      ?? '',
      toKey:        ticket.toKey        ?? '',
      ticketCount:  String(ticket.ticketCount ?? 1),
      fare:         String(ticket.fare         ?? 0),
      unitFare:     String(ticket.unitFare     ?? 0),
      ticketType:   ticket.ticketType   ?? 'full',
      direction:    ticket.direction    ?? 'up',
      busNumber:    ticket.busNumber    ?? '',
      tripNumber:   String(ticket.tripNumber ?? ''),
      luggageAmount:String(ticket.luggageAmount ?? 0),
    });
  };

  const handleUpdate = async () => {
    setLoading(true);
    try {
      await database.write(async () => {
        await editTarget.update(row => {
          row.fromStop      = editForm.fromStop;
          row.toStop        = editForm.toStop;
          row.fromKey       = editForm.fromKey;
          row.toKey         = editForm.toKey;
          row.ticketCount   = Number(editForm.ticketCount) || 1;
          row.fare          = Number(editForm.fare) || 0;
          row.unitFare      = Number(editForm.unitFare) || 0;
          row.ticketType    = editForm.ticketType;
          row.luggageAmount = Number(editForm.luggageAmount) || 0;
          row.busNumber     = editForm.busNumber;
          row.tripNumber    = Number(editForm.tripNumber) || null;
          row.direction     = editForm.direction;
        });
      });
      setEditTarget(null);
      await reload();
    } catch (e) {
      Alert.alert('Update failed', e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = ticket => {
    Alert.alert('Delete ticket', `Ticket from ${ticket.fromStop} → ${ticket.toStop} will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try { await deleteTicket(ticket); await reload(); }
          catch (e) { Alert.alert('Delete failed', e.message); }
        },
      },
    ]);
  };

  return (
    <View style={s.root}>
      <Text style={s.header}>WatermelonDB — POS Ticket CRUD</Text>

      {/* ── CREATE FORM ── */}
      <View style={s.card}>
        <Text style={s.sectionTitle}>Create Test Ticket</Text>

        <View style={s.row}>
          <TextInput style={[s.input, s.flex1]} placeholder="From stop" placeholderTextColor="#9ca3af"
            value={form.fromStop} onChangeText={v => setForm(f => ({ ...f, fromStop: v }))} />
          <TextInput style={[s.input, s.flex1]} placeholder="To stop" placeholderTextColor="#9ca3af"
            value={form.toStop} onChangeText={v => setForm(f => ({ ...f, toStop: v }))} />
        </View>
        <View style={s.row}>
          <TextInput style={[s.input, s.flex1]} placeholder="Fare (total)" placeholderTextColor="#9ca3af"
            keyboardType="numeric" value={form.fare} onChangeText={v => setForm(f => ({ ...f, fare: v }))} />
          <TextInput style={[s.input, s.flex1]} placeholder="Unit fare" placeholderTextColor="#9ca3af"
            keyboardType="numeric" value={form.unitFare} onChangeText={v => setForm(f => ({ ...f, unitFare: v }))} />
          <TextInput style={[s.input, s.flex1]} placeholder="Count" placeholderTextColor="#9ca3af"
            keyboardType="numeric" value={form.ticketCount} onChangeText={v => setForm(f => ({ ...f, ticketCount: v }))} />
        </View>
        <View style={s.row}>
          <TextInput style={[s.input, s.flex1]} placeholder="Bus #" placeholderTextColor="#9ca3af"
            value={form.busNumber} onChangeText={v => setForm(f => ({ ...f, busNumber: v }))} />
          <TextInput style={[s.input, s.flex1]} placeholder="Trip #" placeholderTextColor="#9ca3af"
            keyboardType="numeric" value={form.tripNumber} onChangeText={v => setForm(f => ({ ...f, tripNumber: v }))} />
          <TextInput style={[s.input, s.flex1]} placeholder="Luggage ₹" placeholderTextColor="#9ca3af"
            keyboardType="numeric" value={form.luggageAmount} onChangeText={v => setForm(f => ({ ...f, luggageAmount: v }))} />
        </View>

        <Text style={s.label}>Type</Text>
        <View style={s.chips}>
          {TICKET_TYPES.map(t => (
            <TouchableOpacity key={t}
              style={[s.chip, { borderColor: TYPE_COLOR[t] }, form.ticketType === t && { backgroundColor: TYPE_COLOR[t] }]}
              onPress={() => setForm(f => ({ ...f, ticketType: t }))}>
              <Text style={[s.chipText, form.ticketType === t && s.chipSel]}>{t}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={s.label}>Direction</Text>
        <View style={s.chips}>
          {DIRECTIONS.map(d => (
            <TouchableOpacity key={d}
              style={[s.chip, { borderColor: DIR_COLOR[d] }, form.direction === d && { backgroundColor: DIR_COLOR[d] }]}
              onPress={() => setForm(f => ({ ...f, direction: d }))}>
              <Text style={[s.chipText, form.direction === d && s.chipSel]}>{d === 'up' ? '↑ UP' : '↓ DN'}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity style={s.btnCreate} onPress={handleCreate} disabled={loading}>
          <Text style={s.btnCreateText}>{loading ? 'Saving…' : '+ Add Ticket'}</Text>
        </TouchableOpacity>
      </View>

      {/* ── TICKET LIST ── */}
      <Text style={s.sectionTitle}>All Tickets ({tickets.length})</Text>

      <ScrollView style={s.listScroll} contentContainerStyle={s.listContent}>
        {tickets.length === 0 && (
          <Text style={s.empty}>No tickets yet. Create one above.</Text>
        )}
        {tickets.map(ticket => (
          <View key={ticket.id} style={s.ticketCard}>
            <View style={s.ticketTop}>
              <Text style={s.ticketRoute} numberOfLines={1}>
                {ticket.fromStop} → {ticket.toStop}
              </Text>
              <View style={s.ticketBadges}>
                <View style={[s.badge, { backgroundColor: TYPE_COLOR[ticket.ticketType] ?? '#6b7280' }]}>
                  <Text style={s.badgeText}>{ticket.ticketType}</Text>
                </View>
                <View style={[s.badge, { backgroundColor: DIR_COLOR[ticket.direction] ?? '#6b7280' }]}>
                  <Text style={s.badgeText}>{ticket.direction}</Text>
                </View>
                <View style={[s.badge, ticket.synced ? s.badgeSynced : s.badgeLocal]}>
                  <Text style={s.badgeText}>{ticket.synced ? 'synced' : 'local'}</Text>
                </View>
              </View>
            </View>

            <Text style={s.ticketFare}>₹{ticket.fare}  ×{ticket.ticketCount}  Bus: {ticket.busNumber}</Text>
            {!!ticket.luggageAmount && (
              <Text style={s.ticketFare}>Luggage: ₹{ticket.luggageAmount}</Text>
            )}
            <Text style={s.ticketMeta}>
              ID: {ticket.id.slice(0, 8)}…  ·  {ticket.issuedAt ? new Date(ticket.issuedAt).toLocaleString() : '—'}
            </Text>

            <View style={s.ticketActions}>
              <TouchableOpacity style={s.btnEdit} onPress={() => openEdit(ticket)}>
                <Text style={s.btnEditText}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.btnDelete} onPress={() => handleDelete(ticket)}>
                <Text style={s.btnDeleteText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </ScrollView>

      {/* ── EDIT MODAL ── */}
      <Modal visible={!!editTarget} transparent animationType="slide" onRequestClose={() => setEditTarget(null)}>
        <View style={s.overlay}>
          <View style={s.modal}>
            <Text style={s.sectionTitle}>Edit Ticket</Text>

            <View style={s.row}>
              <TextInput style={[s.input, s.flex1]} placeholder="From stop" placeholderTextColor="#9ca3af"
                value={editForm.fromStop} onChangeText={v => setEditForm(f => ({ ...f, fromStop: v }))} />
              <TextInput style={[s.input, s.flex1]} placeholder="To stop" placeholderTextColor="#9ca3af"
                value={editForm.toStop} onChangeText={v => setEditForm(f => ({ ...f, toStop: v }))} />
            </View>
            <View style={s.row}>
              <TextInput style={[s.input, s.flex1]} placeholder="Fare" placeholderTextColor="#9ca3af"
                keyboardType="numeric" value={editForm.fare} onChangeText={v => setEditForm(f => ({ ...f, fare: v }))} />
              <TextInput style={[s.input, s.flex1]} placeholder="Unit fare" placeholderTextColor="#9ca3af"
                keyboardType="numeric" value={editForm.unitFare} onChangeText={v => setEditForm(f => ({ ...f, unitFare: v }))} />
              <TextInput style={[s.input, s.flex1]} placeholder="Count" placeholderTextColor="#9ca3af"
                keyboardType="numeric" value={editForm.ticketCount} onChangeText={v => setEditForm(f => ({ ...f, ticketCount: v }))} />
            </View>

            <Text style={s.label}>Type</Text>
            <View style={s.chips}>
              {TICKET_TYPES.map(t => (
                <TouchableOpacity key={t}
                  style={[s.chip, { borderColor: TYPE_COLOR[t] }, editForm.ticketType === t && { backgroundColor: TYPE_COLOR[t] }]}
                  onPress={() => setEditForm(f => ({ ...f, ticketType: t }))}>
                  <Text style={[s.chipText, editForm.ticketType === t && s.chipSel]}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={s.label}>Direction</Text>
            <View style={s.chips}>
              {DIRECTIONS.map(d => (
                <TouchableOpacity key={d}
                  style={[s.chip, { borderColor: DIR_COLOR[d] }, editForm.direction === d && { backgroundColor: DIR_COLOR[d] }]}
                  onPress={() => setEditForm(f => ({ ...f, direction: d }))}>
                  <Text style={[s.chipText, editForm.direction === d && s.chipSel]}>{d === 'up' ? '↑ UP' : '↓ DN'}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={s.modalActions}>
              <TouchableOpacity style={s.btnCancel} onPress={() => setEditTarget(null)}>
                <Text style={s.btnCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.btnSave} onPress={handleUpdate} disabled={loading}>
                <Text style={s.btnSaveText}>{loading ? 'Saving…' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: '#0f172a', padding: 16 },
  header:       { fontSize: 18, fontWeight: '700', color: '#f1f5f9', marginBottom: 14 },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: '#94a3b8', marginBottom: 8 },
  card:         { backgroundColor: '#1e293b', borderRadius: 12, padding: 12, marginBottom: 16 },
  row:          { flexDirection: 'row', gap: 6, marginBottom: 0 },
  flex1:        { flex: 1 },
  input:        { backgroundColor: '#0f172a', borderWidth: 1, borderColor: '#334155', borderRadius: 8, color: '#f1f5f9', paddingHorizontal: 10, paddingVertical: 7, marginBottom: 8, fontSize: 13 },
  label:        { color: '#64748b', fontSize: 11, marginBottom: 5 },
  chips:        { flexDirection: 'row', gap: 8, marginBottom: 10 },
  chip:         { borderWidth: 1.5, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 4 },
  chipText:     { fontSize: 12, color: '#94a3b8', textTransform: 'capitalize' },
  chipSel:      { color: '#fff' },
  btnCreate:    { backgroundColor: '#6366f1', borderRadius: 8, paddingVertical: 10, alignItems: 'center', marginTop: 4 },
  btnCreateText:{ color: '#fff', fontWeight: '700', fontSize: 14 },
  listScroll:   { flex: 1 },
  listContent:  { paddingBottom: 32 },
  empty:        { textAlign: 'center', color: '#475569', marginTop: 32, fontSize: 14 },
  ticketCard:   { backgroundColor: '#1e293b', borderRadius: 12, padding: 12, marginBottom: 8 },
  ticketTop:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  ticketRoute:  { fontSize: 14, fontWeight: '600', color: '#f1f5f9', flex: 1, marginRight: 6 },
  ticketBadges: { flexDirection: 'row', gap: 4 },
  badge:        { borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 },
  badgeText:    { fontSize: 10, color: '#fff', fontWeight: '600', textTransform: 'capitalize' },
  badgeSynced:  { backgroundColor: '#166534' },
  badgeLocal:   { backgroundColor: '#7f1d1d' },
  ticketFare:   { color: '#38bdf8', fontSize: 13, marginBottom: 2 },
  ticketMeta:   { color: '#475569', fontSize: 10, marginBottom: 6 },
  ticketActions:{ flexDirection: 'row', gap: 8 },
  btnEdit:      { flex: 1, backgroundColor: '#1d4ed8', borderRadius: 8, paddingVertical: 6, alignItems: 'center' },
  btnEditText:  { color: '#fff', fontWeight: '600', fontSize: 12 },
  btnDelete:    { flex: 1, backgroundColor: '#7f1d1d', borderRadius: 8, paddingVertical: 6, alignItems: 'center' },
  btnDeleteText:{ color: '#fca5a5', fontWeight: '600', fontSize: 12 },
  overlay:      { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modal:        { backgroundColor: '#1e293b', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, paddingBottom: 36 },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  btnCancel:    { flex: 1, borderWidth: 1, borderColor: '#334155', borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  btnCancelText:{ color: '#94a3b8', fontWeight: '600' },
  btnSave:      { flex: 1, backgroundColor: '#6366f1', borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  btnSaveText:  { color: '#fff', fontWeight: '700' },
});