import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  FlatList,
  Modal,
} from 'react-native';
import React, {useState, useEffect} from 'react';
import { ChevronDown } from 'lucide-react-native';

const Dropdown = ({
  data = [],
  onSelect,
  placeholder = 'Select an option...',
  searchPlaceholder = 'Search...',
  isOpen: controlledIsOpen,
  onOpen,
  selectedItem,
  disabledKeys = [],
  startContent = null,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (controlledIsOpen !== undefined) {
      setIsOpen(controlledIsOpen);
    }
  }, [controlledIsOpen]);

  const toggleDropdown = () => {
    if (controlledIsOpen !== undefined && onOpen) {
      // Controlled mode - notify parent
      onOpen();
    } else {
      // Uncontrolled mode - manage own state
      setIsOpen(!isOpen);
    }
  };

  const filteredData = data.filter(item =>
    item.label.toLowerCase().includes(searchQuery.toLowerCase()),
  );
  
  const handleSelect = item => {
    if (disabledKeys.includes(item.key)) return;
    setSearchQuery('');
    onSelect && onSelect(item);
    if (!controlledIsOpen) {
      toggleDropdown();
    }
  };
  

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={[styles.dropdownButton, selectedItem && styles.selectedButton]}
        activeOpacity={0.8}
        onPress={toggleDropdown}>
        <View style={styles.buttonContent}>
          {startContent}
          <Text
            style={[
              styles.selectedText,
              selectedItem && styles.selectedTextActive,
            ]}>
            {selectedItem ? selectedItem.label.split('-')[0] : placeholder}
          </Text>
        </View>
        <ChevronDown color="#00b7f3" size={24} />
      </TouchableOpacity>

      <Modal
        visible={isOpen}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (controlledIsOpen !== undefined && onOpen) {
            onOpen(); // Notify parent to close
          } else {
            setIsOpen(false);
          }
        }}>
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => {
            if (controlledIsOpen !== undefined && onOpen) {
              onOpen(); // Notify parent to close
            } else {
              setIsOpen(false);
            }
          }}>
          <View style={styles.modalContent}>
            <View style={styles.searchContainer}>
              <TextInput
                placeholderTextColor={'gray'}
                style={styles.searchInput}
                placeholder={searchPlaceholder}
                value={searchQuery}
                onChangeText={setSearchQuery}
              />
            </View>
            <FlatList
              data={filteredData}
              keyExtractor={(item, index) => index.toString()}
              renderItem={({item}) => (
                <TouchableOpacity
                  style={[
                    styles.option,
                    {
                      backgroundColor: disabledKeys.includes(item.key)
                        ? '#f0f0f0'
                        : selectedItem?.key === item.key
                        ? '#FFAF45'
                        : '#fff',
                      opacity: disabledKeys.includes(item.key) ? 0.5 : 1,
                    },
                  ]}
                  onPress={() => handleSelect(item)}
                  disabled={disabledKeys.includes(item.key)}>
                  <Text style={styles.optionText}>
                      {item.label.split('-')[1]} - {item.label.split('-')[0]}
                  </Text>
                </TouchableOpacity>
              )}
              style={styles.listContainer}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
};

export default Dropdown;

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    zIndex: 1000,
    marginBottom: 10,
  },
  dropdownButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 20,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#eee',
    minHeight: 70,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  selectedButton: {
    borderColor: '#00b7f3',
    backgroundColor: '#f0f9ff',
  },
  buttonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  selectedText: {
    fontSize: 20,
    color: '#333',
    flex: 1,
  },
  selectedTextActive: {
    color: '#00b7f3',
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '90%',
    maxHeight: '80%',
    minHeight: '70%',
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 5,
    },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 10,
  },
  searchContainer: {
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  searchInput: {
    padding: 12,
    borderRadius: 12,
    fontSize: 20,
    color: '#666',
    backgroundColor: '#f0f0f0',
    borderWidth: 2,
    borderColor: '#ddd',
  },
  listContainer: {
    height: '100%',
  },
  option: {
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  optionText: {
    fontSize: 18,
    color: '#333',
    flex: 1,
  },
});
