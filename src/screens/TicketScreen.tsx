import {
  StyleSheet, Text, TouchableOpacity, View, ScrollView,
  Platform, Modal, Alert,
} from 'react-native';
import React, { useState, useCallback } from 'react';
import { places } from '../utils/places';
import { fareMatrix } from '../utils/fareMatrix';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Receipt, ArrowUpDown, Printer, Minus, Plus, WifiOff } from 'lucide-react-native';
import { useTripContext } from '../context/TripContext';
import { usePosTicketCounter } from '../hooks/usePosTicketCounter';

// ─── NYX imports (Android only) ───────────────────────────────────────────────
let NyxPrinter: any = null;
let PrinterStatus: any = null;
let PrintAlign: any = null;

if (Platform.OS === 'android') {
  const nyx = require('nyx-printer-react-native');
  NyxPrinter = nyx.default;
  PrinterStatus = nyx.PrinterStatus;
  PrintAlign = nyx.PrintAlign;
}

// ─── Component ────────────────────────────────────────────────────────────────
const TicketScreen = () => {
  const { activeTrip, busNumber } = useTripContext();

  // Offline-first ticket counter — handles online, offline, and sync-on-reconnect
  const {
    isSyncing,
    pendingCount,
    assignTicketNumber,
    saveTicket,
    syncPendingTickets,
  } = usePosTicketCounter();

  const [selectedStart, setSelectedStart] = useState<any>(null);
  const [tripDirection, setTripDirection] = useState('down');
  const [selectedDestination, setSelectedDestination] = useState<any>(null);
  const [activeDropdown, setActiveDropdown] = useState<string | null>('start');
  const [fare, setFare] = useState<number | null>(null);
  const [ticketCount, setTicketCount] = useState<number>(1);
  const [showPrintModal, setShowPrintModal] = useState(false);
  const [isPrinting, setIsPrinting] = useState(false);

  // ─── Fare calculation ──────────────────────────────────────────────────────
  const getFare = useCallback((startKey: string, endKey: string) => {
    if (!(fareMatrix as any)?.[startKey]?.[endKey]) return 0;
    return (fareMatrix as any)[startKey][endKey];
  }, []);

  const autoCalculateFare = useCallback(() => {
    if (!selectedStart?.key || !selectedDestination?.key) { setFare(null); return; }
    setFare(getFare(selectedStart.key, selectedDestination.key) * ticketCount);
  }, [selectedStart, selectedDestination, getFare, ticketCount]);

  React.useEffect(() => { autoCalculateFare(); }, [autoCalculateFare]);

  const handleDropdownOpen = (name: string) =>
    setActiveDropdown(prev => (prev === name ? null : name));

  const handleSelectStart = (item: any) => { setSelectedStart(item); setActiveDropdown('destination'); };
  const handleSelectDestination = (item: any) => { setSelectedDestination(item); setActiveDropdown(null); };

  const handleReversePlaces = () => {
    if (selectedStart && selectedDestination) {
      setSelectedStart(selectedDestination);
      setSelectedDestination(selectedStart);
    }
  };

  const isReadyToPrint = selectedStart && selectedDestination && fare;

  // ─── Print handler (offline-safe) ─────────────────────────────────────────
  const handlePrintTicket = async () => {
    if (Platform.OS !== 'android') {
      Alert.alert('Notice', 'Printer is only supported on Android devices.');
      setShowPrintModal(false);
      return;
    }
    if (!activeTrip?.trip_id) {
      Alert.alert('No Active Trip', 'Please start a trip before printing tickets.');
      setShowPrintModal(false);
      return;
    }
    if (!activeTrip?.bus_id) {
      Alert.alert('Bus Not Found', 'No bus linked to this trip.');
      setShowPrintModal(false);
      return;
    }

    setIsPrinting(true);
    try {
      // 1. Check printer first — fail before touching any state
      const ret = await NyxPrinter.getPrinterStatus();
      if (ret !== PrinterStatus.SDK_OK) {
        Alert.alert('Printer Error', PrinterStatus.msg(ret));
        return;
      }

      const ticketParams = {
        busId: activeTrip.bus_id,
        tripId: activeTrip.trip_id,
        fromStopKey: selectedStart.key,
        toStopKey: selectedDestination.key,
        ticketCount,
        fare: fare!,
      };

      // 2. Assign number — works online AND offline
      //    Online  → atomically increments DB counter
      //    Offline → uses local cache, queues for sync later
      const ticketNumber = await assignTicketNumber(ticketParams);

      // 3. Save ticket — online saves to DB immediately, offline queues it
      await saveTicket({ ...ticketParams, ticketNumber });

      // 4. Print
      const BUS_NUMBER = busNumber ?? activeTrip?.bus_number ?? 'N/A';
      const TRIP_NUMBER = activeTrip?.trip_number
        ? `TRP-${String(activeTrip.trip_number).padStart(3, '0')}`
        : 'TRP-???';

      await NyxPrinter.printText('SPS - ZYRAP', { textSize: 32, align: PrintAlign.CENTER });
      await NyxPrinter.printText(
        `Date: ${new Date().toLocaleString()}\nBus: ${BUS_NUMBER}  Trip: ${TRIP_NUMBER}`, {},
      );
      await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });
      await NyxPrinter.printText(`Ticket No: #${ticketNumber}`, { textSize: 26 });
      await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });
      await NyxPrinter.printText(
        `From: ${selectedStart?.label.split('-')[2]}\nTo:   ${selectedDestination?.label.split('-')[2]}\nTickets: ${ticketCount}`, {},
      );
      await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });
      await NyxPrinter.printText(`Total: Rs. ${fare}`, { textSize: 28 });
      await NyxPrinter.printText('** Safe Journey **\n', { align: PrintAlign.CENTER });
      await NyxPrinter.printEndAutoOut();

      setShowPrintModal(false);
      // Reset for next passenger
      setSelectedStart(null);
      setSelectedDestination(null);
      setTicketCount(1);
      setFare(null);
      setActiveDropdown('start');

    } catch (e: any) {
      Alert.alert('Print Error', e.message || 'Unknown error occurred');
    } finally {
      setIsPrinting(false);
    }
  };

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container}>

      {/* ── Offline / Pending sync banner ── */}
      {pendingCount > 0 && (
        <TouchableOpacity
          style={[styles.syncBanner, isSyncing && styles.syncBannerSyncing]}
          onPress={() => syncPendingTickets()}
          disabled={isSyncing}
        >
          <WifiOff size={14} color="#fff" />
          <Text style={styles.syncBannerText}>
            {isSyncing
              ? 'Syncing offline tickets…'
              : `${pendingCount} offline ticket${pendingCount > 1 ? 's' : ''} pending sync — tap to retry`}
          </Text>
        </TouchableOpacity>
      )}

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: isReadyToPrint ? 180 : 100 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Journey Details</Text>
            <Text style={styles.sectionSubtitle}>Fill start and destination</Text>
          </View>

          <View style={styles.placesContainer}>
            {/* ── Starting Place ── */}
            <TouchableOpacity
              style={[styles.selectionHeader, activeDropdown === 'start' && styles.selectionHeaderActive]}
              onPress={() => handleDropdownOpen('start')}
              activeOpacity={0.7}
            >
              <Text style={styles.selectionLabel}>Starting Place</Text>
              <Text style={[styles.selectionValue, !selectedStart && styles.selectionPlaceholder]}>
                {selectedStart ? selectedStart.label.split('-')[0] : 'Select starting place'}
              </Text>
            </TouchableOpacity>

            {activeDropdown === 'start' && (
              <View style={styles.placesGrid}>
                {places.map(place => {
                  const isDisabled = selectedDestination?.key === place.key;
                  const isSelected = selectedStart?.key === place.key;
                  return (
                    <TouchableOpacity
                      key={`start-${place.key}`}
                      style={[styles.placeChip, isSelected && styles.placeChipSelected, isDisabled && styles.placeChipDisabled]}
                      disabled={isDisabled}
                      onPress={() => handleSelectStart(place)}
                    >
                      <Text style={[styles.placeChipText, isSelected && styles.placeChipTextSelected, isDisabled && styles.placeChipTextDisabled]}>
                        {place.label.split('-')[1]} {place.label.split('-')[2]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* ── Destination Place ── */}
            <TouchableOpacity
              style={[styles.selectionHeader, activeDropdown === 'destination' && styles.selectionHeaderActive]}
              onPress={() => handleDropdownOpen('destination')}
              activeOpacity={0.7}
            >
              <Text style={styles.selectionLabel}>Destination Place</Text>
              <Text style={[styles.selectionValue, !selectedDestination && styles.selectionPlaceholder]}>
                {selectedDestination ? selectedDestination.label.split('-')[0] : 'Select destination place'}
              </Text>
            </TouchableOpacity>

            {activeDropdown === 'destination' && (
              <View style={styles.placesGrid}>
                {places
                  .filter((_, idx) => {
                    if (!selectedStart) return true;
                    const startIdx = places.findIndex(p => p.key === selectedStart.key);
                    return tripDirection === 'up' ? idx >= startIdx : idx <= startIdx;
                  })
                  .map(place => {
                    const isDisabled = selectedStart?.key === place.key;
                    const isSelected = selectedDestination?.key === place.key;
                    return (
                      <TouchableOpacity
                        key={`dest-${place.key}`}
                        style={[styles.placeChip, isSelected && styles.placeChipSelected, isDisabled && styles.placeChipDisabled]}
                        disabled={isDisabled}
                        onPress={() => handleSelectDestination(place)}
                      >
                        <Text style={[styles.placeChipText, isSelected && styles.placeChipTextSelected, isDisabled && styles.placeChipTextDisabled]}>
                          {place.label.split('-')[1]} {place.label.split('-')[2]}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
              </View>
            )}

            {(selectedStart || selectedDestination) && (
              <TouchableOpacity
                style={[styles.reverseButton, (!selectedStart || !selectedDestination) && styles.reverseButtonDisabled]}
                onPress={handleReversePlaces}
                disabled={!selectedStart || !selectedDestination}
              >
                <ArrowUpDown size={24} color={!selectedStart || !selectedDestination ? '#ccc' : '#00b7f3'} />
              </TouchableOpacity>
            )}
          </View>

          {isReadyToPrint && (
            <View style={styles.ticketCountContainer}>
              <Text style={styles.ticketCountLabel}>Number of Tickets</Text>
              <View style={styles.ticketCountControls}>
                <TouchableOpacity
                  style={[styles.countButton, ticketCount <= 1 && styles.countButtonDisabled]}
                  onPress={() => ticketCount > 1 && setTicketCount(c => c - 1)}
                  disabled={ticketCount <= 1}
                >
                  <Minus color={ticketCount <= 1 ? '#ccc' : '#00b7f3'} size={24} />
                </TouchableOpacity>
                <Text style={styles.countText}>{ticketCount}</Text>
                <TouchableOpacity style={styles.countButton} onPress={() => setTicketCount(c => c + 1)}>
                  <Plus color="#00b7f3" size={24} />
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>

        {fare && (
          <View style={styles.section}>
            <View style={styles.fareCard}>
              <View style={styles.fareHeader}>
                <Receipt size={24} color="#00b7f3" />
                <Text style={styles.fareTitle}>Fare Breakdown</Text>
              </View>
              <View style={styles.fareDetails}>
                <View style={styles.fareRow}>
                  <Text style={styles.fareLabel}>Base Fare (x{ticketCount})</Text>
                  <Text style={styles.fareValue}>₹{fare}</Text>
                </View>
                <View style={styles.fareDivider} />
                <View style={styles.fareRow}>
                  <Text style={styles.fareTotalLabel}>Total Amount</Text>
                  <Text style={styles.fareTotalValue}>₹{fare}</Text>
                </View>
              </View>
            </View>
          </View>
        )}
      </ScrollView>

      {isReadyToPrint && (
        <View style={styles.paymentBottomContainer}>
          <TouchableOpacity style={styles.payButton} onPress={() => setShowPrintModal(true)}>
            <View style={styles.payButtonContent}>
              <Printer color="#fff" size={24} style={{ marginBottom: 8 }} />
              <Text style={styles.payButtonText}>Print Ticket</Text>
              <Text style={styles.payButtonAmount}>₹{fare}</Text>
            </View>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Print Confirmation Modal ── */}
      <Modal animationType="slide" transparent visible={showPrintModal} onRequestClose={() => setShowPrintModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Printer size={32} color="#00b7f3" />
              <Text style={styles.modalTitle}>Ticket Details</Text>
            </View>

            <View style={styles.modalContent}>
              <View style={styles.ticketDetailRow}>
                <Text style={styles.ticketDetailLabel}>From:</Text>
                <Text style={styles.ticketDetailValue}>{selectedStart?.label}</Text>
              </View>
              <View style={styles.ticketDetailRow}>
                <Text style={styles.ticketDetailLabel}>To:</Text>
                <Text style={styles.ticketDetailValue}>{selectedDestination?.label}</Text>
              </View>
              <View style={styles.ticketDetailRow}>
                <Text style={styles.ticketDetailLabel}>Tickets:</Text>
                <Text style={styles.ticketDetailValue}>{ticketCount}</Text>
              </View>
              <View style={styles.fareDivider} />
              <View style={styles.ticketDetailRow}>
                <Text style={styles.ticketDetailLabel}>Total Fare:</Text>
                <Text style={styles.fareTotalValue}>₹{fare}</Text>
              </View>
              <View style={styles.ticketNumberNote}>
                <Text style={styles.ticketNumberNoteText}>
                  🎫 Ticket # assigned on print • offline tickets sync automatically
                </Text>
              </View>
            </View>

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.modalCancelButton}
                onPress={() => setShowPrintModal(false)}
                disabled={isPrinting}
              >
                <Text style={styles.modalCancelText}>Close</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalPrintButton, isPrinting && styles.modalPrintButtonDisabled]}
                onPress={handlePrintTicket}
                disabled={isPrinting}
              >
                <Text style={styles.modalPrintText}>{isPrinting ? 'Printing…' : 'Confirm Print'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
};

export default TicketScreen;

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8f9fa', paddingTop: 20 },
  syncBanner: {
    backgroundColor: '#f59e0b',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    gap: 8,
  },
  syncBannerSyncing: { backgroundColor: '#0ea5e9' },
  syncBannerText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  scrollView: { flex: 1 },
  scrollContent: { paddingTop: 8 },
  section: { marginBottom: 24, paddingHorizontal: 20 },
  sectionHeader: { marginBottom: 16 },
  sectionTitle: { fontSize: 20, fontWeight: '700', color: '#1a1a1a', marginBottom: 4 },
  sectionSubtitle: { fontSize: 14, color: '#666', lineHeight: 20 },
  placesContainer: { position: 'relative', marginBottom: 20 },
  selectionHeader: {
    backgroundColor: '#fff', borderRadius: 12, padding: 16,
    borderWidth: 1, borderColor: '#eee', marginBottom: 8,
  },
  selectionHeaderActive: { borderColor: '#00b7f3', backgroundColor: '#f0f9ff' },
  selectionLabel: { fontSize: 12, color: '#666', marginBottom: 4, fontWeight: '500' },
  selectionValue: { fontSize: 18, color: '#1a1a1a', fontWeight: '600' },
  selectionPlaceholder: { color: '#999', fontWeight: '400' },
  placesGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16, paddingHorizontal: 4 },
  placeChip: {
    backgroundColor: '#fff', paddingVertical: 10, paddingHorizontal: 16,
    borderRadius: 20, borderWidth: 1, borderColor: '#e0e0e0',
  },
  placeChipSelected: { backgroundColor: '#00b7f3', borderColor: '#00b7f3' },
  placeChipDisabled: { backgroundColor: '#f5f5f5', borderColor: '#f0f0f0', opacity: 0.5 },
  placeChipText: { fontSize: 14, color: '#333', fontWeight: '500' },
  placeChipTextSelected: { color: '#fff' },
  placeChipTextDisabled: { color: '#999' },
  reverseButton: {
    position: 'absolute', right: 16, top: 36, backgroundColor: '#fff',
    borderRadius: 24, width: 48, height: 48, justifyContent: 'center', alignItems: 'center',
    elevation: 6, zIndex: 10, borderWidth: 2, borderColor: '#f0f0f0',
  },
  reverseButtonDisabled: { backgroundColor: '#f8f8f8', borderColor: '#eaeaea' },
  ticketCountContainer: {
    backgroundColor: '#fff', borderRadius: 12, padding: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1, borderColor: '#eee', marginTop: 12,
  },
  ticketCountLabel: { fontSize: 16, color: '#1a1a1a', fontWeight: '600' },
  ticketCountControls: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#f8f9fa', borderRadius: 24, borderWidth: 1, borderColor: '#eee',
  },
  countButton: { padding: 8, borderRadius: 20, backgroundColor: '#fff' },
  countButtonDisabled: { backgroundColor: '#f5f5f5' },
  countText: { fontSize: 18, fontWeight: '700', color: '#1a1a1a', paddingHorizontal: 16, minWidth: 40, textAlign: 'center' },
  fareCard: { backgroundColor: '#fff', borderRadius: 16, padding: 20, elevation: 6, borderWidth: 1, borderColor: '#f0f0f0' },
  fareHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  fareTitle: { fontSize: 18, fontWeight: '700', color: '#1a1a1a', marginLeft: 12 },
  fareDetails: { gap: 12 },
  fareRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fareLabel: { fontSize: 14, color: '#666', fontWeight: '500' },
  fareValue: { fontSize: 14, color: '#1a1a1a', fontWeight: '600' },
  fareDivider: { height: 1, backgroundColor: '#e0e0e0', marginVertical: 8 },
  fareTotalLabel: { fontSize: 16, color: '#1a1a1a', fontWeight: '700' },
  fareTotalValue: { fontSize: 18, color: '#00b7f3', fontWeight: '700' },
  ticketNumberNote: {
    marginTop: 12, backgroundColor: '#f0f9ff', borderRadius: 8,
    padding: 10, borderWidth: 1, borderColor: '#bae6fd',
  },
  ticketNumberNoteText: { fontSize: 12, color: '#0369a1', textAlign: 'center', fontWeight: '500' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalContainer: { backgroundColor: '#fff', borderRadius: 20, padding: 24, width: '100%', maxWidth: 400, elevation: 10 },
  modalHeader: { alignItems: 'center', marginBottom: 20 },
  modalTitle: { fontSize: 22, fontWeight: '700', color: '#1a1a1a', marginTop: 12, textAlign: 'center' },
  modalContent: { marginBottom: 24 },
  ticketDetailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
  ticketDetailLabel: { fontSize: 16, color: '#666', fontWeight: '500' },
  ticketDetailValue: { fontSize: 16, color: '#1a1a1a', fontWeight: '600', flex: 1, textAlign: 'right', marginLeft: 16 },
  modalButtons: { flexDirection: 'row', gap: 12 },
  modalCancelButton: { flex: 1, backgroundColor: '#f0f0f0', paddingVertical: 14, paddingHorizontal: 20, borderRadius: 12, alignItems: 'center' },
  modalCancelText: { fontSize: 16, color: '#666', fontWeight: '600' },
  modalPrintButton: { flex: 1, backgroundColor: '#00b7f3', paddingVertical: 14, paddingHorizontal: 20, borderRadius: 12, alignItems: 'center' },
  modalPrintButtonDisabled: { backgroundColor: '#80dbf9' },
  modalPrintText: { fontSize: 16, color: '#fff', fontWeight: '700' },
  paymentBottomContainer: {
    backgroundColor: '#F2F2F2', paddingTop: 20, paddingHorizontal: 20,
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
    borderTopWidth: 1, borderTopColor: '#e0e0e0', elevation: 10,
  },
  payButton: { backgroundColor: '#00b7f3', borderRadius: 16, padding: 16, alignItems: 'center', justifyContent: 'center', elevation: 8 },
  payButtonContent: { alignItems: 'center', flexDirection: 'column' },
  payButtonText: { color: '#fff', fontSize: 18, fontWeight: '700', marginBottom: 4 },
  payButtonAmount: { color: '#e6f7fd', fontSize: 16, fontWeight: '600' },
});