/**
 * ReviewScreen.tsx
 * Comprehensive Verification & Edit Screen for Guest Document Extractions.
 *
 * Features:
 * - Top 42%: Pinch-to-zoom / pan document preview synchronized to active document tab.
 * - Tab Filter: Selectively displays fields for PASSPORT, VISA, STAMP, FORM_C, or ALL.
 * - Complete Form-C Field Coverage: Handles all 12 items from Form-C (Rule 14),
 *   plus visa stamps and passport metadata.
 * - Preserves all manual edits across tabs and saves directly to local SQLite.
 */

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
  Dimensions,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useAppTheme } from '../theme/ThemeContext';
import { openDatabase, updateSubmissionStatus, GuestDocumentRecord } from '../db/database';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface ReviewScreenProps {
  submissionId: string;
  onFinishReview: () => void;
  onCancel: () => void;
}

/**
 * Complete Form-C Guest Record covering Passport Bio, Visa/OCI, Entry Stamp,
 * and all 12 numbered fields of the Arrival Report (Rule 14).
 */
export interface CompleteFormCFields {
  // --- 1. Passport Bio ---
  surname: string;
  givenName: string;
  sex: string;
  dateOfBirth: string;
  nationality: string;
  passportNumber: string;
  passportExpiryDate: string;

  // --- 2. Visa / OCI ---
  visaNumber: string;
  visaType: string;
  visaIssueDate: string;
  visaExpiryDate: string;
  visaPlaceOfIssue: string;

  // --- 3. Entry Immigration Stamp ---
  arrivalDateIndia: string;
  arrivalPortIndia: string;

  // --- 4. Handwritten Form-C Arrival Report (Rule 14) ---
  permanentAddress: string;
  city: string;
  country: string;
  contactEmail: string;
  contactPhone: string;
  arrivalDatetimeHomestay: string;
  arrivedFrom: string;
  proceedingTo: string;
  stayDurationIndia: string;
  purposeOfVisit: string;
  expectedDepartureDate: string;
  arrivedCountryCityIndia: string;
}

// Available document preview tabs
type DocumentTabKey = 'passport' | 'visa' | 'stamp' | 'form_c' | 'photo' | 'all';

export const ReviewScreen: React.FC<ReviewScreenProps> = ({
  submissionId,
  onFinishReview,
  onCancel,
}) => {
  // Theme context providing dynamic light/dark colors
  const { colors, isDark, toggleTheme } = useAppTheme();

  // Screen state
  const [loading, setLoading] = useState<boolean>(true);
  const [guestDoc, setGuestDoc] = useState<GuestDocumentRecord | null>(null);
  const [selectedDocTab, setSelectedDocTab] = useState<DocumentTabKey>('passport');
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // Editable Form-C verified fields state
  const [formData, setFormData] = useState<CompleteFormCFields>({
    surname: '',
    givenName: '',
    sex: '',
    dateOfBirth: '',
    nationality: '',
    passportNumber: '',
    passportExpiryDate: '',

    visaNumber: '',
    visaType: '',
    visaIssueDate: '',
    visaExpiryDate: '',
    visaPlaceOfIssue: '',

    arrivalDateIndia: '',
    arrivalPortIndia: '',

    permanentAddress: '',
    city: '',
    country: '',
    contactEmail: '',
    contactPhone: '',
    arrivalDatetimeHomestay: '',
    arrivedFrom: '',
    proceedingTo: '',
    stayDurationIndia: '',
    purposeOfVisit: '',
    expectedDepartureDate: '',
    arrivedCountryCityIndia: '',
  });

  /**
   * Loads the guest document record and parses extracted JSON on initial mount.
   */
  useEffect(() => {
    const loadDocumentData = async () => {
      try {
        setLoading(true);
        const db = await openDatabase();

        // Query guest document record for this submission
        const docs = await db.getAllAsync<GuestDocumentRecord>(
          `SELECT * FROM guest_documents WHERE submission_id = ? ORDER BY guest_index ASC LIMIT 1;`,
          [submissionId]
        );

        if (docs.length > 0) {
          const doc = docs[0];
          setGuestDoc(doc);

          if (doc.extracted_data_json) {
            try {
              const parsed = JSON.parse(doc.extracted_data_json);

              // Helper function to extract string values whether flat or wrapped in { value, confidence }
              const extractVal = (field: any, fallback: string = ''): string => {
                if (field === null || field === undefined) {
                  return fallback;
                }
                if (typeof field === 'object' && 'value' in field) {
                  return field.value !== null && field.value !== undefined ? String(field.value) : fallback;
                }
                return String(field);
              };

              setFormData({
                // Passport fields
                surname: extractVal(parsed.surname || parsed.last_name),
                givenName: extractVal(parsed.given_names || parsed.given_name || parsed.first_name),
                sex: extractVal(parsed.sex),
                dateOfBirth: extractVal(parsed.date_of_birth || parsed.dob),
                nationality: extractVal(parsed.nationality),
                passportNumber: extractVal(parsed.passport_number || parsed.passport_no || parsed.pass_num),
                passportExpiryDate: extractVal(parsed.passport_expiry_date || parsed.expiry_date),

                // Visa fields
                visaNumber: extractVal(parsed.visa_number || parsed.visa_no || parsed.visa_num),
                visaType: extractVal(parsed.visa_type, 'TOURIST'),
                visaIssueDate: extractVal(parsed.visa_issue_date || parsed.issue_date),
                visaExpiryDate: extractVal(parsed.visa_expiry_date),
                visaPlaceOfIssue: extractVal(parsed.visa_place_of_issue || parsed.place_of_issue),

                // Stamp fields
                arrivalDateIndia: extractVal(parsed.arrival_date_india || parsed.arrival_date),
                arrivalPortIndia: extractVal(parsed.arrival_port_india || parsed.arrival_port),

                // Form-C Arrival Report fields
                permanentAddress: extractVal(parsed.permanent_address || parsed.full_address),
                city: extractVal(parsed.city),
                country: extractVal(parsed.country),
                contactEmail: extractVal(parsed.contact_email || parsed.email),
                contactPhone: extractVal(parsed.contact_phone || parsed.telephone_mobile),
                arrivalDatetimeHomestay: extractVal(parsed.arrival_datetime_homestay || parsed.datetime_arrival_homestay),
                arrivedFrom: extractVal(parsed.arrived_from || parsed.arri_from),
                proceedingTo: extractVal(parsed.proceeding_to || parsed.proc_to),
                stayDurationIndia: extractVal(parsed.stay_duration_india || parsed.proposed_duration_stay_india),
                purposeOfVisit: extractVal(parsed.purpose_of_visit || parsed.purpose_of_visit_profession, 'Tourism'),
                expectedDepartureDate: extractVal(parsed.expected_departure_date || parsed.expected_date_departure),
                arrivedCountryCityIndia: extractVal(parsed.arrived_country_city_india || parsed.country_city_arrived_to_india),
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
   * Updates specific field value in state.
   */
  const handleFieldChange = (field: keyof CompleteFormCFields, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  /**
   * Persists verified values back to SQLite and marks submission as 'REVIEWED'.
   */
  const handleSaveAndConfirm = async () => {
    try {
      setIsSaving(true);
      const db = await openDatabase();

      // Persist full JSON into guest_documents table
      const updatedJson = JSON.stringify(formData);
      await db.runAsync(
        `UPDATE guest_documents SET extracted_data_json = ? WHERE submission_id = ?;`,
        [updatedJson, submissionId]
      );

      // Advance submission state to REVIEWED
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
   * Resolves active document image path based on selected preview tab.
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
      case 'photo':
        return guestDoc.guest_photo_path;
      case 'all':
        return guestDoc.passport_bio_path;
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

  // Helper renderer for an individual form text field
  const renderField = (label: string, fieldKey: keyof CompleteFormCFields, placeholder: string) => (
    <View style={styles.fieldGroup} key={fieldKey}>
      <Text style={[styles.label, { color: colors.textMuted }]}>{label}</Text>
      <TextInput
        style={[
          styles.input,
          {
            backgroundColor: colors.surface,
            color: colors.textPrimary,
            borderColor: colors.border,
          },
        ]}
        value={formData[fieldKey]}
        onChangeText={(text) => handleFieldChange(fieldKey, text)}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        autoCapitalize="characters"
      />
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView
        style={styles.keyboardContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
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

        {/* Top 42%: Pinch-to-Zoom Document Preview */}
        <View style={[styles.imageViewerSection, { backgroundColor: colors.surfaceSubtle }]}>
          {/* Document Switcher Tabs */}
          <View style={styles.tabRow}>
            {(['passport', 'visa', 'stamp', 'form_c', 'photo', 'all'] as const).map((tabKey) => (
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
                  {tabKey === 'form_c' ? 'FORM-C' : tabKey.toUpperCase()}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Pinch-to-Zoom Scroll Container */}
          <View style={styles.imageWrapper}>
            {activeImage ? (
              <ScrollView
                style={styles.zoomScrollView}
                contentContainerStyle={styles.zoomContentContainer}
                maximumZoomScale={4.0}
                minimumZoomScale={1.0}
                showsHorizontalScrollIndicator={false}
                showsVerticalScrollIndicator={false}
                centerContent={true}
              >
                <Image
                  source={{ uri: activeImage }}
                  style={styles.previewImage}
                  resizeMode="contain"
                />
              </ScrollView>
            ) : (
              <View style={styles.emptyImageContainer}>
                <Text style={[styles.emptyImageText, { color: colors.textMuted }]}>
                  No image available for this document
                </Text>
              </View>
            )}
            <View style={styles.zoomHintBadge}>
              <Text style={styles.zoomHintText}>🔍 Pinch to zoom</Text>
            </View>
          </View>
        </View>

        {/* Bottom 58%: Tab-Filtered Editable Form Fields */}
        <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
          {/* Section: PASSPORT */}
          {(selectedDocTab === 'passport' || selectedDocTab === 'all') && (
            <View style={styles.sectionContainer}>
              <Text style={[styles.sectionHeading, { color: colors.primaryBrand }]}>
                🛂 Passport / Identity Details
              </Text>
              {renderField('Surname (As in Passport)', 'surname', 'e.g. DOE')}
              {renderField('Given Name(s)', 'givenName', 'e.g. JOHN BAUER')}
              {renderField('Sex (M / F / O)', 'sex', 'M')}
              {renderField('Date of Birth (YYYY-MM-DD)', 'dateOfBirth', 'YYYY-MM-DD')}
              {renderField('Nationality', 'nationality', 'e.g. American')}
              {renderField('Passport Number', 'passportNumber', 'e.g. A12345678')}
              {renderField('Passport Expiry Date', 'passportExpiryDate', 'YYYY-MM-DD')}
            </View>
          )}

          {/* Section: VISA */}
          {(selectedDocTab === 'visa' || selectedDocTab === 'all') && (
            <View style={styles.sectionContainer}>
              <Text style={[styles.sectionHeading, { color: colors.primaryBrand }]}>
                📑 Visa / OCI Details
              </Text>
              {renderField('Visa / OCI Number', 'visaNumber', 'e.g. V1234567')}
              {renderField('Visa Type', 'visaType', 'e.g. TOURIST')}
              {renderField('Visa Issue Date', 'visaIssueDate', 'YYYY-MM-DD')}
              {renderField('Visa Expiry Date', 'visaExpiryDate', 'YYYY-MM-DD')}
              {renderField('Visa Place of Issue', 'visaPlaceOfIssue', 'e.g. LONDON')}
            </View>
          )}

          {/* Section: STAMP */}
          {(selectedDocTab === 'stamp' || selectedDocTab === 'all') && (
            <View style={styles.sectionContainer}>
              <Text style={[styles.sectionHeading, { color: colors.primaryBrand }]}>
                🛬 Entry Immigration Stamp
              </Text>
              {renderField('Date of Arrival in India', 'arrivalDateIndia', 'YYYY-MM-DD')}
              {renderField('Port of Arrival in India', 'arrivalPortIndia', 'e.g. COCHIN AIRPORT')}
            </View>
          )}

          {/* Section: FORM-C ARRIVAL REPORT (Rule 14) */}
          {(selectedDocTab === 'form_c' || selectedDocTab === 'all') && (
            <View style={styles.sectionContainer}>
              <Text style={[styles.sectionHeading, { color: colors.primaryBrand }]}>
                📝 Form-C Arrival Report (Rule 14)
              </Text>
              {renderField('Permanent Address in Country of Residence', 'permanentAddress', 'Street address')}
              {renderField('City', 'city', 'City')}
              {renderField('Country', 'country', 'Country of residence')}
              {renderField('Email Address', 'contactEmail', 'guest@example.com')}
              {renderField('Telephone / Mobile Number', 'contactPhone', '+1 234 567 8900')}
              {renderField('Date & Time of Arrival in Homestay', 'arrivalDatetimeHomestay', 'YYYY-MM-DD HH:MM')}
              {renderField('Arrived From (City / Country)', 'arrivedFrom', 'e.g. London, UK')}
              {renderField('Proceeding To (Destination)', 'proceedingTo', 'e.g. Munnar, Kerala')}
              {renderField('Proposed Duration of Stay in India', 'stayDurationIndia', 'e.g. 14 Days')}
              {renderField('Purpose of Visit & Profession', 'purposeOfVisit', 'Tourism')}
              {renderField('Expected Date of Departure', 'expectedDepartureDate', 'YYYY-MM-DD')}
              {renderField('Country & City You Arrived to India', 'arrivedCountryCityIndia', 'e.g. UK, London')}
            </View>
          )}

          {/* Section: PHOTO */}
          {selectedDocTab === 'photo' && (
            <View style={styles.sectionContainer}>
              <Text style={[styles.sectionHeading, { color: colors.primaryBrand }]}>
                👤 Guest Portrait Photo
              </Text>
              <Text style={[styles.helperText, { color: colors.textMuted }]}>
                Passport portrait photo cropped for portal upload. You can edit guest names below:
              </Text>
              {renderField('Given Name(s)', 'givenName', 'e.g. JOHN')}
              {renderField('Surname', 'surname', 'e.g. DOE')}
            </View>
          )}

          {/* Confirm & Save Button */}
          <TouchableOpacity
            disabled={isSaving}
            onPress={handleSaveAndConfirm}
            style={[styles.confirmButton, { backgroundColor: colors.statusReady }]}
          >
            {isSaving ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.confirmButtonText}>Confirm & Mark Reviewed ✓</Text>
            )}
          </TouchableOpacity>

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  keyboardContainer: {
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
    borderBottomColor: '#CBD5E1',
    position: 'relative',
  },
  tabRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    height: 40,
    borderBottomWidth: 1,
    borderBottomColor: '#CBD5E1',
  },
  tabButton: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
    borderBottomWidth: 2,
  },
  tabButtonText: {
    fontSize: 11,
  },
  imageWrapper: {
    flex: 1,
    position: 'relative',
  },
  zoomScrollView: {
    flex: 1,
  },
  zoomContentContainer: {
    width: SCREEN_WIDTH,
    minHeight: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  previewImage: {
    width: SCREEN_WIDTH,
    height: 220,
  },
  emptyImageContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyImageText: {
    fontSize: 13,
  },
  zoomHintBadge: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  zoomHintText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '600',
  },
  formContent: {
    padding: 16,
    paddingBottom: 48,
  },
  sectionContainer: {
    marginBottom: 8,
  },
  sectionHeading: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 12,
    marginTop: 4,
  },
  helperText: {
    fontSize: 12,
    marginBottom: 10,
  },
  fieldGroup: {
    marginBottom: 12,
  },
  label: {
    fontSize: 12,
    marginBottom: 4,
    fontWeight: '600',
  },
  input: {
    height: 44,
    borderRadius: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    fontSize: 14,
  },
  confirmButton: {
    height: 50,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
    marginBottom: 16,
  },
  confirmButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
});

export default ReviewScreen;