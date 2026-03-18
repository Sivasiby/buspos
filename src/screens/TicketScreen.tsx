import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ScrollView,
  Platform,
  Modal,
  Alert,
} from 'react-native';

import React, {useState, useCallback} from 'react';
import {places} from '../utils/places';
import {fareMatrix} from '../utils/fareMatrix';
import {SafeAreaView} from 'react-native-safe-area-context';
import { 
  Receipt, 
  ArrowUpDown,
  Printer,
  Minus,
  Plus
} from 'lucide-react-native';

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

const TicketScreen = () => {
  const [selectedStart, setSelectedStart] = useState<any>(null);
  const [tripDirection, setTripDirection] = useState('down');
  const [selectedDestination, setSelectedDestination] = useState<any>(null);
  const [activeDropdown, setActiveDropdown] = useState<string | null>('start');

  const [fare, setFare] = useState<number | null>(null);
  const [ticketCount, setTicketCount] = useState<number>(1);

  const [showPrintModal, setShowPrintModal] = useState(false);

  // ─── Calculations ────────────────────────────────────────────────────────
  
  const getFare = useCallback(
    (startPlace: any, endPlace: any) => {
      const startKey = startPlace as string;
      const endKey = endPlace as string;
      if (!(fareMatrix as any)?.[startKey]?.[endKey]) return 0;
      return (fareMatrix as any)[startKey][endKey];
    },
    [],
  );

  const autoCalculateFare = useCallback(() => {
    if (!selectedStart || !selectedDestination) {
      setFare(null);
      return;
    }

    if (selectedStart?.key && selectedDestination?.key) {
      const computedFare = getFare(selectedStart.key, selectedDestination.key);
      setFare(computedFare * ticketCount);
    }
  }, [selectedStart, selectedDestination, getFare, ticketCount]);

  React.useEffect(() => {
    autoCalculateFare();
  }, [autoCalculateFare]);

  const handleDropdownOpen = (dropdownName: string) => {
    setActiveDropdown(prev => prev === dropdownName ? null : dropdownName);
  };

  const handleSelectStart = (item: any) => {
    setSelectedStart(item);
    setActiveDropdown('destination');
  };

  const handleSelectDestination = (item: any) => {
    setSelectedDestination(item);
    setActiveDropdown(null);
  };

  const handleReversePlaces = () => {
    if (selectedStart && selectedDestination) {
      const tempStart = selectedStart;
      setSelectedStart(selectedDestination);
      setSelectedDestination(tempStart);
    }
  };

  const isReadyToPrint = selectedStart && selectedDestination && fare;

  const handlePrintTicket = async () => {
    if (Platform.OS !== 'android') {
      Alert.alert('Notice', 'Printer is only supported on Android devices.');
      setShowPrintModal(false);
      return;
    }

    try {
      const ret = await NyxPrinter.getPrinterStatus();
      if (ret !== PrinterStatus.SDK_OK) {
        Alert.alert('Printer Error', PrinterStatus.msg(ret));
        return;
      }

      // Hardcoded variables for now
      const MOCK_HEADER = "SPS - ZYRAP";
      const MOCK_BUS_NUMBER = "AP 39 X 1234";
      const MOCK_TRIP_NUMBER = "TRP-001";

      await NyxPrinter.printText(MOCK_HEADER, {
  textSize: 32,
  align: PrintAlign.CENTER,
});

await NyxPrinter.printText(
  `Date: ${new Date().toLocaleString()}\nBus: ${MOCK_BUS_NUMBER}  Trip: ${MOCK_TRIP_NUMBER}`,
  {},
);

await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });

await NyxPrinter.printText(
  `From: ${selectedStart?.label.split('-')[2]}\nTo:   ${selectedDestination?.label.split('-')[2]}\nTickets: ${ticketCount}`,
  {},
);

await NyxPrinter.printText('--------------------------------', { align: PrintAlign.CENTER });

await NyxPrinter.printText(`Total: Rs. ${fare}`, { textSize: 28 });

await NyxPrinter.printText('** Safe Journey **\n', { align: PrintAlign.CENTER });

await NyxPrinter.printEndAutoOut();
      
      setShowPrintModal(false);
    } catch (e: any) {
      Alert.alert('Print Error', e.message || 'Unknown error occurred');
    }
  };

  const incrementTickets = () => {
    setTicketCount(prev => prev + 1);
  };

  const decrementTickets = () => {
    if (ticketCount > 1) {
      setTicketCount(prev => prev - 1);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[
          styles.scrollContent,
          {paddingBottom: isReadyToPrint ? 180 : 100},
        ]}
        showsVerticalScrollIndicator={false}>

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Journey Details</Text>
            <Text style={styles.sectionSubtitle}>
              Fill start and destination
            </Text>
          </View>

          <View style={styles.placesContainer}>
            {/* Start Place Section */}
            <TouchableOpacity 
              style={[styles.selectionHeader, activeDropdown === 'start' && styles.selectionHeaderActive]}
              onPress={() => handleDropdownOpen('start')}
              activeOpacity={0.7}
            >
              <View>
                <Text style={styles.selectionLabel}>Starting Place</Text>
                <Text style={[styles.selectionValue, !selectedStart && styles.selectionPlaceholder]}>
                  {selectedStart ? selectedStart.label.split('-')[0] : 'Select starting place'}
                </Text>
              </View>
            </TouchableOpacity>

            {activeDropdown === 'start' && (
              <View style={styles.placesGrid}>
                {places.map((place) => {
                  const isDisabled = selectedDestination?.key === place.key;
                  const isSelected = selectedStart?.key === place.key;
                  return (
                    <TouchableOpacity
                      key={`start-${place.key}`}
                      style={[
                        styles.placeChip,
                        isSelected && styles.placeChipSelected,
                        isDisabled && styles.placeChipDisabled
                      ]}
                      disabled={isDisabled}
                      onPress={() => handleSelectStart(place)}
                    >
                      <Text style={[
                        styles.placeChipText,
                        isSelected && styles.placeChipTextSelected,
                        isDisabled && styles.placeChipTextDisabled
                      ]}>
                        {place.label.split('-')[1]} {place.label.split('-')[2]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* Destination Place Section */}
            <TouchableOpacity 
              style={[styles.selectionHeader, activeDropdown === 'destination' && styles.selectionHeaderActive]}
              onPress={() => handleDropdownOpen('destination')}
              activeOpacity={0.7}
            >
              <View>
                <Text style={styles.selectionLabel}>Destination Place</Text>
                <Text style={[styles.selectionValue, !selectedDestination && styles.selectionPlaceholder]}>
                  {selectedDestination ? selectedDestination.label.split('-')[0] : 'Select destination place'}
                </Text>
              </View>
            </TouchableOpacity>

            {activeDropdown === 'destination' && (
  <View style={styles.placesGrid}>
    {places
      .filter((_, idx) => {
  if (!selectedStart) return true;
  const startIdx = places.findIndex(p => p.key === selectedStart.key);
  return tripDirection === 'up'
    ? idx >= startIdx
    : idx <= startIdx;
})
      .map((place) => {
                  const isDisabled = selectedStart?.key === place.key;
                  const isSelected = selectedDestination?.key === place.key;
                  return (
                    <TouchableOpacity
                      key={`dest-${place.key}`}
                      style={[
                        styles.placeChip,
                        isSelected && styles.placeChipSelected,
                        isDisabled && styles.placeChipDisabled
                      ]}
                      disabled={isDisabled}
                      onPress={() => handleSelectDestination(place)}
                    >
                      <Text style={[
                        styles.placeChipText,
                        isSelected && styles.placeChipTextSelected,
                        isDisabled && styles.placeChipTextDisabled
                      ]}>
                        {place.label.split('-')[1]} {place.label.split('-')[2]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {(selectedStart || selectedDestination) && (
              <TouchableOpacity
                style={[
                  styles.reverseButton,
                  (!selectedStart || !selectedDestination) &&
                    styles.reverseButtonDisabled,
                ]}
                onPress={handleReversePlaces}
                disabled={!selectedStart || !selectedDestination}>
                <ArrowUpDown
                  size={24}
                  color={
                    !selectedStart || !selectedDestination ? '#ccc' : '#00b7f3'
                  }
                />
              </TouchableOpacity>
            )}
          </View>
          
          {isReadyToPrint && (
            <View style={styles.ticketCountContainer}>
              <Text style={styles.ticketCountLabel}>Number of Tickets</Text>
              <View style={styles.ticketCountControls}>
                <TouchableOpacity 
                  style={[styles.countButton, ticketCount <= 1 && styles.countButtonDisabled]} 
                  onPress={decrementTickets}
                  disabled={ticketCount <= 1}
                >
                  <Minus color={ticketCount <= 1 ? '#ccc' : '#00b7f3'} size={24} />
                </TouchableOpacity>
                <Text style={styles.countText}>{ticketCount}</Text>
                <TouchableOpacity 
                  style={styles.countButton} 
                  onPress={incrementTickets}
                >
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
          <TouchableOpacity
            style={styles.payButton}
            onPress={() => setShowPrintModal(true)}>
            <View style={styles.payButtonContent}>
              <Printer color="#fff" size={24} style={{marginBottom: 8}} />
              <Text style={styles.payButtonText}>Print Ticket</Text>
              <Text style={styles.payButtonAmount}>₹{fare}</Text>
            </View>
          </TouchableOpacity>
        </View>
      )}

      {/* Print Details Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={showPrintModal}
        onRequestClose={() => setShowPrintModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Printer size={32} color="#00b7f3" />
              <Text style={styles.modalTitle}>Ticket Details</Text>
            </View>

            <View style={styles.modalContent}>
              <View style={styles.ticketDetailRow}>
                <Text style={styles.ticketDetailLabel}>From:</Text>
                <Text style={styles.ticketDetailValue}>
                  {selectedStart?.label}
                </Text>
              </View>
              
              <View style={styles.ticketDetailRow}>
                <Text style={styles.ticketDetailLabel}>To:</Text>
                <Text style={styles.ticketDetailValue}>
                  {selectedDestination?.label}
                </Text>
              </View>

              <View style={styles.ticketDetailRow}>
                <Text style={styles.ticketDetailLabel}>Tickets:</Text>
                <Text style={styles.ticketDetailValue}>
                  {ticketCount}
                </Text>
              </View>
              
              <View style={styles.fareDivider} />
              
              <View style={styles.ticketDetailRow}>
                <Text style={styles.ticketDetailLabel}>Total Fare:</Text>
                <Text style={styles.fareTotalValue}>₹{fare}</Text>
              </View>
            </View>

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.modalCancelButton}
                onPress={() => setShowPrintModal(false)}>
                <Text style={styles.modalCancelText}>Close</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalPrintButton}
                onPress={handlePrintTicket}>
                <Text style={styles.modalPrintText}>Confirm Print</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
};

export default TicketScreen;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8f9fa',
    paddingTop: 20,
  },
  networkAlert: {
    backgroundColor: '#f44336',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  networkAlertText: {
    color: '#fff',
    marginLeft: 8,
    fontSize: 14,
    fontWeight: '500',
  },
  scrollView: {flex: 1},
  scrollContent: {paddingTop: 8},
  loadingContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    zIndex: 1000,
  },
  errorContainer: {
    margin: 20,
    padding: 16,
    backgroundColor: '#fee',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#fcc',
  },
  errorText: {
    color: '#c33',
    textAlign: 'center',
    fontSize: 16,
  },
  section: {
    marginBottom: 24,
    paddingHorizontal: 20,
  },
  sectionHeader: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 4,
  },
  sectionSubtitle: {
    fontSize: 14,
    color: '#666',
    lineHeight: 20,
  },
  routeInfo: {
    backgroundColor: '#e6f7fd',
    padding: 16,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#b3ecf7',
  },
  routeText: {
    fontSize: 16,
    color: '#00b7f3',
    fontWeight: '600',
    marginLeft: 12,
    flex: 1,
  },
  scanButton: {
    backgroundColor: '#00b7f3',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    marginBottom: 20,
    elevation: 6,
  },
  scanButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 12,
  },
  dividerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 20,
  },
  divider: {flex: 1, height: 1, backgroundColor: '#e0e0e0'},
  dividerText: {
    marginHorizontal: 16,
    color: '#999',
    fontSize: 14,
    fontWeight: '500',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  searchInput: {
    flex: 1,
    borderWidth: 2,
    borderColor: '#e0e0e0',
    borderRadius: 12,
    fontSize: 16,
    padding: 16,
    color: '#1a1a1a',
    backgroundColor: '#fff',
    fontWeight: '500',
  },
  searchButton: {
    backgroundColor: '#fff',
    borderRadius: 12,
    width: 52,
    height: 52,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 12,
    borderWidth: 2,
    borderColor: '#e0e0e0',
  },
  busResults: {gap: 12},
  busItem: {
    backgroundColor: '#fff',
    borderRadius: 12,
    elevation: 3,
    borderWidth: 1,
    borderColor: '#f0f0f0',
  },
  busItemContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  busItemName: {
    fontSize: 16,
    color: '#1a1a1a',
    fontWeight: '600',
    marginBottom: 2,
  },
  busItemNumber: {fontSize: 14, color: '#666', fontWeight: '500'},
  noResultsContainer: {alignItems: 'center', paddingVertical: 40},
  noResultsText: {fontSize: 18, color: '#999', fontWeight: '600', marginTop: 12},
  noResultsSubtext: {fontSize: 14, color: '#ccc', marginTop: 4},
  selectedBusItem: {
    backgroundColor: '#fff',
    borderRadius: 12,
    elevation: 3,
    borderWidth: 2,
    borderColor: '#00b7f3',
  },
  selectedBusContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 8,
  },
  selectedBusInfo: {flexDirection: 'row', alignItems: 'center'},
  selectedBusText: {
    marginLeft: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 15,
  },
  selectedBusName: {fontSize: 16, color: '#1a1a1a', fontWeight: '700'},
  selectedBusNumber: {fontSize: 14, color: '#00b7f3', fontWeight: '600'},
  changeText: {fontSize: 14, color: '#00b7f3', fontWeight: '600'},
  placesContainer: {position: 'relative', marginBottom: 20},
  selectionHeader: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#eee',
    marginBottom: 8,
  },
  selectionHeaderActive: {
    borderColor: '#00b7f3',
    backgroundColor: '#f0f9ff',
  },
  selectionLabel: {
    fontSize: 12,
    color: '#666',
    marginBottom: 4,
    fontWeight: '500',
  },
  selectionValue: {
    fontSize: 18,
    color: '#1a1a1a',
    fontWeight: '600',
  },
  selectionPlaceholder: {
    color: '#999',
    fontWeight: '400',
  },
  placesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
    paddingHorizontal: 4,
  },
  placeChip: {
    backgroundColor: '#fff',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  placeChipSelected: {
    backgroundColor: '#00b7f3',
    borderColor: '#00b7f3',
  },
  placeChipDisabled: {
    backgroundColor: '#f5f5f5',
    borderColor: '#f0f0f0',
    opacity: 0.5,
  },
  placeChipText: {
    fontSize: 14,
    color: '#333',
    fontWeight: '500',
  },
  placeChipTextSelected: {
    color: '#fff',
  },
  placeChipTextDisabled: {
    color: '#999',
  },
  reverseButton: {
    position: 'absolute',
    right: 16,
    top: 36,
    backgroundColor: '#fff',
    borderRadius: 24,
    width: 48,
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 6,
    zIndex: 10,
    borderWidth: 2,
    borderColor: '#f0f0f0',
  },
  reverseButtonDisabled: {
    backgroundColor: '#f8f8f8',
    borderColor: '#eaeaea',
  },
  ticketCountContainer: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#eee',
    marginTop: 12,
  },
  ticketCountLabel: {
    fontSize: 16,
    color: '#1a1a1a',
    fontWeight: '600',
  },
  ticketCountControls: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8f9fa',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#eee',
  },
  countButton: {
    padding: 8,
    borderRadius: 20,
    backgroundColor: '#fff',
  },
  countButtonDisabled: {
    backgroundColor: '#f5f5f5',
  },
  countText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a1a1a',
    paddingHorizontal: 16,
    minWidth: 40,
    textAlign: 'center',
  },
  savePrefsButton: {
    backgroundColor: '#DDF6D2',
    padding: 5,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#4CAF50',
  },
  fareCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 20,
    elevation: 6,
    borderWidth: 1,
    borderColor: '#f0f0f0',
  },
  fareHeader: {flexDirection: 'row', alignItems: 'center', marginBottom: 16},
  fareTitle: {fontSize: 18, fontWeight: '700', color: '#1a1a1a', marginLeft: 12},
  fareDetails: {gap: 12},
  fareRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  fareLabel: {fontSize: 14, color: '#666', fontWeight: '500'},
  fareValue: {fontSize: 14, color: '#1a1a1a', fontWeight: '600'},
  fareDivider: {height: 1, backgroundColor: '#e0e0e0', marginVertical: 8},
  fareTotalLabel: {fontSize: 16, color: '#1a1a1a', fontWeight: '700'},
  fareTotalValue: {fontSize: 18, color: '#00b7f3', fontWeight: '700'},
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContainer: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 400,
    elevation: 10,
  },
  modalHeader: {
    alignItems: 'center',
    marginBottom: 20,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1a1a1a',
    marginTop: 12,
    textAlign: 'center',
  },
  modalContent: {
    marginBottom: 24,
  },
  ticketDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  ticketDetailLabel: {
    fontSize: 16,
    color: '#666',
    fontWeight: '500',
  },
  ticketDetailValue: {
    fontSize: 16,
    color: '#1a1a1a',
    fontWeight: '600',
    flex: 1,
    textAlign: 'right',
    marginLeft: 16,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  modalCancelButton: {
    flex: 1,
    backgroundColor: '#f0f0f0',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 16,
    color: '#666',
    fontWeight: '600',
  },
  modalPrintButton: {
    flex: 1,
    backgroundColor: '#00b7f3',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalPrintText: {
    fontSize: 16,
    color: '#fff',
    fontWeight: '700',
  },
  paymentBottomContainer: {
    backgroundColor: '#F2F2F2',
    paddingTop: 20,
    paddingHorizontal: 20,
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
    elevation: 10,
  },
  payButton: {
    backgroundColor: '#00b7f3',
    borderRadius: 16,
    padding: 16,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 8,
  },
  payButtonContent: {
    alignItems: 'center',
    flexDirection: 'column',
  },
  payButtonText: {
    color: '#fff', 
    fontSize: 18, 
    fontWeight: '700', 
    marginBottom: 4
  },
  payButtonAmount: {
    color: '#e6f7fd', 
    fontSize: 16, 
    fontWeight: '600'
  }
});