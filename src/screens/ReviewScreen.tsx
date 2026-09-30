import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  TextInput,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useAppTheme } from '../theme/ThemeContext';
import { openDatabase, updateSubmissionStatus, GuestDocumentRecord } from '../db/database';

interface ReviewScreenProps {
  submissionId: string;
  onFinishReview: () => void;
  onCancel: () => void;
}

/**
 * Standard fields mapped from Form-C Arrival Report and Passport Bio data.
 */
interface FormCFields {
  surname: string;
  givenName: string;
  passportNumber: string;
  nationality: string;
  dateOfBirth: string;
  visaNumber: string;
  arrivedFrom: string;
  proceedingTo: string;
  purposeOfVisit: string;
}

export const ReviewScreen: React.FC<ReviewScreenProps> = ({
  submissionId,
  onFinishReview,
  onCancel,
}) => {
  const { colors, isDark, toggleTheme } = useAppTheme();

  // Screen state
  const [loading, setLoading] = useState<boolean>(true);
  const [guestDoc, setGuestDoc] = useState<GuestDocumentRecord | null>(null);
  const [selectedDocTab, setSelectedDocTab] = useState<'passport' | 'visa' | 'stamp' | 'form_c'>('passport');
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // Editable Form-C verified fields
  const [formData, setFormData] = useState<FormCFields>({
    surname: '',
    givenName: '',
    passportNumber: '',
    nationality: '',
    dateOfBirth: '',
    visaNumber: '',
    arrivedFrom: '',
    proceedingTo: '',
    purposeOfVisit: '',
  });

  /**
   * Loads the guest document record and parses extracted JSON on initial mount.
   */
  useEffect(() => {
    const loadDocumentData = async () => {
      try {
        setLoading(true);
        const db = await openDatabase();

        // 1. Fetch document record associated with this submission
        const docs = await db.getAllAsync<GuestDocumentRecord>(
          `SELECT * FROM guest_documents WHERE submission_id = ? ORDER BY guest_index ASC LIMIT 1;`,
          [submissionId]
        );

        if (docs.length > 0) {
          const doc = docs[0];
          setGuestDoc(doc);

          // 2. Parse extracted OCR JSON if available
          if (doc.extracted_data_json) {
            try {
              const parsed = JSON.parse(doc.extracted_data_json);
              setFormData({
                surname: parsed.surname || parsed.last_name || '',
                givenName: parsed.given_name || parsed.first_name || '',
                passportNumber: parsed.passport_number || parsed.passport_no || '',
                nationality: parsed.nationality || '',
                dateOfBirth: parsed.date_of_birth || parsed.dob || '',
                visaNumber: parsed.visa_number || parsed.visa_no || '',
                arrivedFrom: parsed.arrived_from || '',
                proceedingTo: parsed.proceeding_to || '',
                purposeOfVisit: parsed.purpose_of_visit || 'Tourism',
              });
            } catch (err) {
              console.warn('[ReviewScreen] Could not parse extracted JSON payload:', err);
            }
          }
        }
      } catch (error: any) {
        Alert.alert('Load Error', error.message || 'Failed to load submission data.');
      } finally {
        setLoading(false);
      }
    };

    loadDocumentData();
  }, [submissionId]);

  /**
   * Helper to update specific field values in form state.
   */
  const handleFieldChange = (field: keyof FormCFields, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  /**
   * Persists verified values back to SQLite and marks submission status as 'REVIEWED'.
   */
  const handleSaveAndConfirm = async () => {
    try {
      setIsSaving(true);
      const db = await openDatabase();

      // 1. Persist updated JSON values into guest_documents
      const updatedJson = JSON.stringify(formData);
      await db.runAsync(
        `UPDATE guest_documents SET extracted_data_json = ? WHERE submission_id = ?;`,
        [updatedJson, submissionId]
      );

      // 2. Advance submission state to REVIEWED
      await updateSubmissionStatus(submissionId, 'REVIEWED');

      setIsSaving(false);
      Alert.alert('Verified', 'Document details verified and marked as REVIEWED.', [
        { text: 'OK', onPress: onFinishReview },
      ]);
    } catch (error: any) {
      setIsSaving(false);
      Alert.alert('Save Error', error.message || 'Failed to confirm review.');
    }
  };

  /**
   * Determines active document image URI based on selected tab.
   */
  const getActiveImageUri = (): string | undefined => {
    if (!guestDoc) return undefined;
    switch (selectedDocTab) {
      case 'passport':
        return guestDoc.passport_bio_path;
      case 'visa':
        return guestDoc.visa_stamp_path;
      case 'stamp':
        return guestDoc.entry_stamp_path;
      case 'form_c':
        return guestDoc.form_c_path;
      default:
        return guestDoc.passport_bio_path;
    }
  };

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primaryBrand} />
      </View>
    );
  }

  const activeImage = getActiveImageUri();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Top Header Bar */}
      <View style={[styles.headerBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={onCancel} style={styles.headerButton}>
          <Text style={[styles.headerButtonText, { color: colors.textMuted }]}>Close</Text>
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>Verify Document</Text>
        <TouchableOpacity onPress={toggleTheme} style={styles.themeToggle}>
          <Text style={styles.themeToggleText}>{isDark ? '☀️' : '🌙'}</Text>
        </TouchableOpacity>
      </View>

      {/* Top 45%: Document Preview Canvas */}
      <View style={[styles.imageViewerSection, { backgroundColor: colors.surfaceSubtle }]}>
        {/* Document Switcher Tabs */}
        <View style={styles.tabRow}>
          {(['passport', 'visa', 'stamp', 'form_c'] as const).map((tabKey) => (
            <TouchableOpacity
              key={tabKey}
              onPress={() => setSelectedDocTab(tabKey)}
              style={[
                styles.tabButton,
                {
                  borderBottomColor:
                    selectedDocTab === tabKey ? colors.primaryBrand : 'transparent',
                },
              ]}
            >
              <Text
                style={[
                  styles.tabButtonText,
                  {
                    color: selectedDocTab === tabKey ? colors.primaryBrand : colors.textMuted,
                    fontWeight: selectedDocTab === tabKey ? '700' : '500',
                  },
                ]}
              >
                {tabKey.toUpperCase()}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Scaled Document Canvas */}
        <View style={styles.imageWrapper}>
          {activeImage ? (
            <Image source={{ uri: activeImage }} style={styles.previewImage} resizeMode="contain" />
          ) : (
            <View style={styles.emptyImageContainer}>
              <Text style={[styles.emptyImageText, { color: colors.textMuted }]}>
                No image available for this document
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* Bottom 55%: Scrollable Verification Form */}
      <ScrollView contentContainerStyle={styles.formContent}>
        <Text style={[styles.sectionHeading, { color: colors.textPrimary }]}>
          Form-C Foreigner Details
        </Text>

        {/* Given Name */}
        <View style={styles.fieldGroup}>
          <Text style={[styles.label, { color: colors.textMuted }]}>Given Name(s)</Text>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surface, color: colors.textPrimary, borderColor: colors.border }]}
            value={formData.givenName}
            onChangeText={(text) => handleFieldChange('givenName', text)}
            placeholder="Given Name"
            placeholderTextColor={colors.textMuted}
          />
        </View>

        {/* Surname */}
        <View style={styles.fieldGroup}>
          <Text style={[styles.label, { color: colors.textMuted }]}>Surname</Text>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surface, color: colors.textPrimary, borderColor: colors.border }]}
            value={formData.surname}
            onChangeText={(text) => handleFieldChange('surname', text)}
            placeholder="Surname"
            placeholderTextColor={colors.textMuted}
          />
        </View>

        {/* Passport Number */}
        <View style={styles.fieldGroup}>
          <Text style={[styles.label, { color: colors.textMuted }]}>Passport Number</Text>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surface, color: colors.textPrimary, borderColor: colors.border }]}
            value={formData.passportNumber}
            onChangeText={(text) => handleFieldChange('passportNumber', text)}
            placeholder="Passport Number"
            placeholderTextColor={colors.textMuted}
          />
        </View>

        {/* Nationality */}
        <View style={styles.fieldGroup}>
          <Text style={[styles.label, { color: colors.textMuted }]}>Nationality</Text>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surface, color: colors.textPrimary, borderColor: colors.border }]}
            value={formData.nationality}
            onChangeText={(text) => handleFieldChange('nationality', text)}
            placeholder="Nationality"
            placeholderTextColor={colors.textMuted}
          />
        </View>

        {/* Date of Birth */}
        <View style={styles.fieldGroup}>
          <Text style={[styles.label, { color: colors.textMuted }]}>Date of Birth (DD/MM/YYYY)</Text>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surface, color: colors.textPrimary, borderColor: colors.border }]}
            value={formData.dateOfBirth}
            onChangeText={(text) => handleFieldChange('dateOfBirth', text)}
            placeholder="DD/MM/YYYY"
            placeholderTextColor={colors.textMuted}
          />
        </View>

        {/* Visa / OCI Number */}
        <View style={styles.fieldGroup}>
          <Text style={[styles.label, { color: colors.textMuted }]}>Visa / OCI Number</Text>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surface, color: colors.textPrimary, borderColor: colors.border }]}
            value={formData.visaNumber}
            onChangeText={(text) => handleFieldChange('visaNumber', text)}
            placeholder="Visa Number"
            placeholderTextColor={colors.textMuted}
          />
        </View>

        {/* Arrived From */}
        <View style={styles.fieldGroup}>
          <Text style={[styles.label, { color: colors.textMuted }]}>Arrived From (City / Country)</Text>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surface, color: colors.textPrimary, borderColor: colors.border }]}
            value={formData.arrivedFrom}
            onChangeText={(text) => handleFieldChange('arrivedFrom', text)}
            placeholder="e.g. London, UK"
            placeholderTextColor={colors.textMuted}
          />
        </View>

        {/* Proceeding To */}
        <View style={styles.fieldGroup}>
          <Text style={[styles.label, { color: colors.textMuted }]}>Proceeding To (Destination)</Text>
          <TextInput
            style={[styles.input, { backgroundColor: colors.surface, color: colors.textPrimary, borderColor: colors.border }]}
            value={formData.proceedingTo}
            onChangeText={(text) => handleFieldChange('proceedingTo', text)}
            placeholder="e.g. Munnar, Kerala"
            placeholderTextColor={colors.textMuted}
          />
        </View>

        {/* Confirm & Save Button */}
        <TouchableOpacity
          disabled={isSaving}
          onPress={handleSaveAndConfirm}
          style={[styles.confirmButton, { backgroundColor: colors.statusReady }]}
        >
          {isSaving ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.confirmButtonText}>Confirm & Mark Reviewed</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerBar: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  headerButton: {
    padding: 4,
  },
  headerButtonText: {
    fontSize: 15,
  },
  themeToggle: {
    padding: 6,
  },
  themeToggleText: {
    fontSize: 18,
  },
  imageViewerSection: {
    height: '42%',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  tabRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    height: 38,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  tabButton: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 8,
    borderBottomWidth: 2,
  },
  tabButtonText: {
    fontSize: 12,
  },
  imageWrapper: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  emptyImageContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyImageText: {
    fontSize: 13,
  },
  formContent: {
    padding: 16,
    paddingBottom: 48,
  },
  sectionHeading: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 16,
  },
  fieldGroup: {
    marginBottom: 14,
  },
  label: {
    fontSize: 13,
    marginBottom: 4,
    fontWeight: '500',
  },
  input: {
    height: 44,
    borderRadius: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    fontSize: 14,
  },
  confirmButton: {
    height: 48,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
  },
  confirmButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
});