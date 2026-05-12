import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from 'react-native';

const SAMPLE_NAMES = ['Arun', 'Priya', 'Soundarkumar', 'Karthik', 'Meena', 'Rajesh', 'Lakshmi'];

const translateToTamil = async (name) => {
  try {
    const response = await fetch(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ta&dt=t&q=${encodeURIComponent(name)}`
    );
    const data = await response.json();
    return data[0][0][0]; // extract translated text
  } catch (error) {
    console.error('Translation error:', error);
    return name;
  }
};

export default function Test() {
  const [inputName, setInputName] = useState('');
  const [tamilName, setTamilName] = useState('');
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleTranslate = async (name = inputName) => {
    const trimmed = name.trim();
    if (!trimmed) return;

    setLoading(true);
    setError('');
    setTamilName('');

    try {
      const result = await translateToTamil(trimmed);
      setTamilName(result);
      setHistory((prev) => [
        { english: trimmed, tamil: result, id: Date.now() },
        ...prev.slice(0, 9),
      ]);
    } catch (err) {
      setError('Translation failed. Check your internet connection.');
    } finally {
      setLoading(false);
    }
  };

  const handleSamplePress = (name) => {
    setInputName(name);
    handleTranslate(name);
  };

  const handleClear = () => {
    setInputName('');
    setTamilName('');
    setError('');
  };

  return (
    <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Tamil Translator</Text>
        <Text style={styles.headerSubtitle}>English → தமிழ்  •  Powered by MyMemory</Text>
      </View>

      {/* Input Section */}
      <View style={styles.card}>
        <Text style={styles.label}>Enter Name (English)</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. Soundarkumar"
          placeholderTextColor="#aaa"
          value={inputName}
          onChangeText={(text) => {
            setInputName(text);
            setError('');
          }}
          onSubmitEditing={() => handleTranslate()}
          returnKeyType="done"
          autoCapitalize="words"
        />

        {/* Error */}
        {error !== '' && (
          <Text style={styles.errorText}>⚠️ {error}</Text>
        )}

        <View style={styles.buttonRow}>
          <TouchableOpacity
            style={[
              styles.button,
              styles.primaryButton,
              (!inputName.trim() || loading) && styles.disabledButton,
            ]}
            onPress={() => handleTranslate()}
            disabled={!inputName.trim() || loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.primaryButtonText}>Translate →</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity style={[styles.button, styles.clearButton]} onPress={handleClear}>
            <Text style={styles.clearButtonText}>Clear</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Result */}
      {tamilName !== '' && (
        <View style={styles.resultCard}>
          <Text style={styles.resultLabel}>Translation Result</Text>
          <Text style={styles.resultEnglish}>{inputName}</Text>
          <Text style={styles.arrow}>↓</Text>
          <Text style={styles.resultTamil}>{tamilName}</Text>
        </View>
      )}

      {/* Sample Names */}
      <View style={styles.card}>
        <Text style={styles.label}>Try Sample Names</Text>
        <View style={styles.chipContainer}>
          {SAMPLE_NAMES.map((name) => (
            <TouchableOpacity
              key={name}
              style={styles.chip}
              onPress={() => handleSamplePress(name)}
              disabled={loading}
            >
              <Text style={styles.chipText}>{name}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* History */}
      {history.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.label}>Recent Translations</Text>
          {history.map((item) => (
            <View key={item.id} style={styles.historyRow}>
              <Text style={styles.historyEnglish}>{item.english}</Text>
              <Text style={styles.historyArrow}>→</Text>
              <Text style={styles.historyTamil}>{item.tamil}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Note */}
      <View style={styles.noteCard}>
        <Text style={styles.noteTitle}>💡 Note</Text>
        <Text style={styles.noteText}>
          MyMemory API is free with a limit of 1000 words/day. No API key or billing required.
          Requires internet connection to translate.
        </Text>
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F4F6FB',
  },
  header: {
    backgroundColor: '#0f4c81',
    paddingTop: 60,
    paddingBottom: 28,
    paddingHorizontal: 24,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: 0.5,
  },
  headerSubtitle: {
    fontSize: 13,
    color: '#93c5fd',
    marginTop: 5,
    fontWeight: '500',
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    marginHorizontal: 16,
    marginTop: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 12,
  },
  input: {
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 18,
    color: '#111827',
    backgroundColor: '#fafafa',
  },
  errorText: {
    color: '#dc2626',
    fontSize: 13,
    marginTop: 8,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  button: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButton: {
    backgroundColor: '#0f4c81',
    flex: 2,
  },
  disabledButton: {
    backgroundColor: '#93c5fd',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  clearButton: {
    backgroundColor: '#f3f4f6',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  clearButtonText: {
    color: '#6b7280',
    fontSize: 15,
    fontWeight: '600',
  },
  resultCard: {
    backgroundColor: '#0f4c81',
    borderRadius: 16,
    padding: 24,
    marginHorizontal: 16,
    marginTop: 16,
    alignItems: 'center',
    shadowColor: '#0f4c81',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
  resultLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#93c5fd',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginBottom: 12,
  },
  resultEnglish: {
    fontSize: 20,
    color: '#bfdbfe',
    fontWeight: '500',
  },
  arrow: {
    fontSize: 20,
    color: '#60a5fa',
    marginVertical: 8,
  },
  resultTamil: {
    fontSize: 42,
    color: '#ffffff',
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 56,
  },
  chipContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    backgroundColor: '#eff6ff',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  chipText: {
    color: '#1d4ed8',
    fontSize: 14,
    fontWeight: '600',
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    gap: 10,
  },
  historyEnglish: {
    fontSize: 15,
    color: '#374151',
    fontWeight: '500',
    flex: 1,
  },
  historyArrow: {
    fontSize: 14,
    color: '#9ca3af',
  },
  historyTamil: {
    fontSize: 20,
    color: '#0f4c81',
    fontWeight: '600',
    flex: 1,
    textAlign: 'right',
  },
  noteCard: {
    backgroundColor: '#eff6ff',
    borderRadius: 16,
    padding: 16,
    marginHorizontal: 16,
    marginTop: 16,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  noteTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1e40af',
    marginBottom: 6,
  },
  noteText: {
    fontSize: 13,
    color: '#1d4ed8',
    lineHeight: 20,
  },
});