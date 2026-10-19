/**
 * ReviewScreen.tsx
 * Comprehensive Verification & Edit Screen for Guest Document Extractions.
 *
 * Architecture & Features:
 * - Top 42%: Pinch-to-zoom / pan document preview synchronized to the active document tab.
 * - Strict Tab Isolation: Selectively displays ONLY fields extracted from the active scan
 *   (Passport Bio, Visa/OCI, Entry Stamp, or Handwritten Form-C Rule 14).
 * - Master Portal Tab ('ALL'): Consolidates all 26+ fields into an official Form-C submission view.
 * - Provenance Badges: Visually highlights extraction engine (MRZ vs VLM) and confidence scores.
 * - Native Theme Integration: Fully reactive to light/dark themes via useAppTheme.
 * - Preserves manual overrides and writes updates directly to SQLite via openDatabase.
 */

import React, { useState, useEffect, useMemo } from 'react';
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

// Application Theme and Database Providers
import { useAppTheme } from '../theme/ThemeContext';
import { openDatabase, updateSubmissionStatus, GuestDocumentRecord } from '../db/database';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Available document preview tabs
export type DocumentTabKey = 'passport' | 'visa' | 'stamp' | 'form_c' | 'photo' | 'all';

interface ReviewScreenProps {
  submissionId: string;
  onFinishReview: () => void;
  onCancel: () => void;
}

/**
 * Metadata descriptor for each Form-C field.
 */
interface FieldDescriptor {
  key: keyof CompleteFormCFields;
  label: string;
  placeholder: string;
  documentCategory: 'passport' | 'visa' | 'stamp' | 'form_c';
  autoCapitalize?: 'none' | 'characters' | 'words' | 'sentences';
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

/**
 * Master Registry mapping every field to its originating scan.
 */
const FIELD_REGISTRY: FieldDescriptor[] = [
  // 1. Passport Bio Scan Fields
  { key: 'surname', label: 'Surname (As in Passport)', placeholder: 'e.g. SMITH', documentCategory: 'passport', autoCapitalize: 'characters' },
  { key: 'givenName', label: 'Given Name(s)', placeholder: 'e.g. JOHN DOE', documentCategory: 'passport', autoCapitalize: 'characters' },
  { key: 'sex', label: 'Sex / Gender (M / F / X)', placeholder: 'M, F, or X', documentCategory: 'passport', autoCapitalize: 'characters' },
  { key: 'dateOfBirth', label: 'Date of Birth (YYYY-MM-DD)', placeholder: 'YYYY-MM-DD', documentCategory: 'passport', autoCapitalize: 'none' },
  { key: 'nationality', label: 'Nationality', placeholder: 'e.g. CANADIAN', documentCategory: 'passport', autoCapitalize: 'characters' },
  { key: 'passportNumber', label: 'Passport Number', placeholder: 'Alphanumeric passport no.', documentCategory: 'passport', autoCapitalize: 'characters' },
  { key: 'passportExpiryDate', label: 'Passport Expiration Date', placeholder: 'YYYY-MM-DD', documentCategory: 'passport', autoCapitalize: 'none' },

  // 2. Visa / OCI Scan Fields
  { key: 'visaNumber', label: 'Visa / OCI Number', placeholder: 'e.g. V1234567', documentCategory: 'visa', autoCapitalize: 'characters' },
  { key: 'visaType', label: 'Visa Type / Category', placeholder: 'e.g. TOURIST', documentCategory: 'visa', autoCapitalize: 'characters' },
  { key: 'visaIssueDate', label: 'Visa Issue Date', placeholder: 'YYYY-MM-DD', documentCategory: 'visa', autoCapitalize: 'none' },
  { key: 'visaExpiryDate', label: 'Visa Expiry Date', placeholder: 'YYYY-MM-DD', documentCategory: 'visa', autoCapitalize: 'none' },
  { key: 'visaPlaceOfIssue', label: 'Visa Place of Issue', placeholder: 'e.g. OTTAWA', documentCategory: 'visa', autoCapitalize: 'characters' },

  // 3. Entry Immigration Stamp Fields
  { key: 'arrivalDateIndia', label: 'Date of Arrival in India', placeholder: 'YYYY-MM-DD', documentCategory: 'stamp', autoCapitalize: 'none' },
  { key: 'arrivalPortIndia', label: 'Port of Arrival in India', placeholder: 'e.g. COCHIN AIRPORT', documentCategory: 'stamp', autoCapitalize: 'characters' },

  // 4. Handwritten Form-C Arrival Report (Rule 14) Fields
  { key: 'permanentAddress', label: 'Permanent Residential Address Abroad', placeholder: 'Street address in country of residence', documentCategory: 'form_c', autoCapitalize: 'words' },
  { key: 'city', label: 'City of Residence', placeholder: 'e.g. Toronto', documentCategory: 'form_c', autoCapitalize: 'words' },
  { key: 'country', label: 'Country of Residence', placeholder: 'e.g. Canada', documentCategory: 'form_c', autoCapitalize: 'words' },
  { key: 'contactEmail', label: 'Email Address', placeholder: 'guest@example.com', documentCategory: 'form_c', autoCapitalize: 'none' },
  { key: 'contactPhone', label: 'Telephone / Mobile Number', placeholder: '+1 234 567 8900', documentCategory: 'form_c', autoCapitalize: 'none' },
  { key: 'arrivalDatetimeHomestay', label: 'Date & Time of Arrival at Homestay', placeholder: 'YYYY-MM-DD HH:MM', documentCategory: 'form_c', autoCapitalize: 'none' },
  { key: 'arrivedFrom', label: 'Arrived From (Previous Transit / City)', placeholder: 'e.g. London, UK', documentCategory: 'form_c', autoCapitalize: 'words' },
  { key: 'proceedingTo', label: 'Proceeding To (Next Destination)', placeholder: 'e.g. Munnar, Kerala', documentCategory: 'form_c', autoCapitalize: 'words' },
  { key: 'stayDurationIndia', label: 'Proposed Duration of Stay in India', placeholder: 'e.g. 14 Days', documentCategory: 'form_c', autoCapitalize: 'words' },
  { key: 'purposeOfVisit', label: 'Purpose of Visit & Profession', placeholder: 'e.g. Tourism, Teacher', documentCategory: 'form_c', autoCapitalize: 'words' },
  { key: 'expectedDepartureDate', label: 'Expected Date of Departure', placeholder: 'YYYY-MM-DD', documentCategory: 'form_c', autoCapitalize: 'none' },
  { key: 'arrivedCountryCityIndia', label: 'Country & City Arrived In India', placeholder: 'e.g. Canada, Toronto', documentCategory: 'form_c', autoCapitalize: 'words' },
];

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

  // Field values state
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

  // Metadata tracking provenance source and confidence scores per field
  const [metadata, setMetadata] = useState<Record<string, { confidence: number; source: string }>>({});

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

              const metaMap: Record<string, { confidence: number; source: string }> = {};

              // Helper function to extract string values and capture provenance metadata
              const extractField = (fieldObj: any, key: string, fallback: string = ''): string => {
                if (fieldObj === null || fieldObj === undefined) {
                  metaMap[key] = { confidence: 0.0, source: 'unassigned' };
                  return fallback;
                }
                if (typeof fieldObj === 'object' && 'value' in fieldObj) {
                  metaMap[key] = {
                    confidence: typeof fieldObj.confidence === 'number' ? fieldObj.confidence : 0.80,
                    source: fieldObj.source || 'qwen2_vl',
                  };
                  return fieldObj.value !== null && fieldObj.value !== undefined ? String(fieldObj.value) : fallback;
                }
                metaMap[key] = { confidence: 0.80, source: 'raw_string' };
                return String(fieldObj);
              };

              setFormData({
                // Passport fields
                surname: extractField(parsed.surname || parsed.last_name, 'surname'),
                givenName: extractField(parsed.given_names || parsed.given_name || parsed.first_name, 'givenName'),
                sex: extractField(parsed.sex, 'sex'),
                dateOfBirth: extractField(parsed.date_of_birth || parsed.dob, 'dateOfBirth'),
                nationality: extractField(parsed.nationality, 'nationality'),
                passportNumber: extractField(parsed.passport_number || parsed.passport_no || parsed.pass_num, 'passportNumber'),
                passportExpiryDate: extractField(parsed.passport_expiry_date || parsed.expiry_date, 'passportExpiryDate'),

                // Visa fields
                visaNumber: extractField(parsed.visa_number || parsed.visa_no || parsed.visa_num, 'visaNumber'),
                visaType: extractField(parsed.visa_type, 'visaType', 'TOURIST'),
                visaIssueDate: extractField(parsed.visa_issue_date || parsed.issue_date, 'visaIssueDate'),
                visaExpiryDate: extractField(parsed.visa_expiry_date, 'visaExpiryDate'),
                visaPlaceOfIssue: extractField(parsed.visa_place_of_issue || parsed.place_of_issue, 'visaPlaceOfIssue'),

                // Stamp fields
                arrivalDateIndia: extractField(parsed.arrival_date_india || parsed.arrival_date, 'arrivalDateIndia'),
                arrivalPortIndia: extractField(parsed.arrival_port_india || parsed.arrival_port, 'arrivalPortIndia'),

                // Form-C Arrival Report fields
                permanentAddress: extractField(parsed.permanent_address || parsed.full_address, 'permanentAddress'),
                city: extractField(parsed.city, 'city'),
                country: extractField(parsed.country, 'country'),
                contactEmail: extractField(parsed.contact_email || parsed.email, 'contactEmail'),
                contactPhone: extractField(parsed.contact_phone || parsed.telephone_mobile, 'contactPhone'),
                arrivalDatetimeHomestay: extractField(parsed.arrival_datetime_homestay || parsed.datetime_arrival_homestay, 'arrivalDatetimeHomestay'),
                arrivedFrom: extractField(parsed.arrived_from || parsed.arri_from, 'arrivedFrom'),
                proceedingTo: extractField(parsed.proceeding_to || parsed.proc_to, 'proceedingTo'),
                stayDurationIndia: extractField(parsed.stay_duration_india || parsed.proposed_duration_stay_india, 'stayDurationIndia'),
                purposeOfVisit: extractField(parsed.purpose_of_visit || parsed.purpose_of_visit_profession, 'purposeOfVisit', 'Tourism'),
                expectedDepartureDate: extractField(parsed.expected_departure_date || parsed.expected_date_departure, 'expectedDepartureDate'),
                arrivedCountryCityIndia: extractField(parsed.arrived_country_city_india || parsed.country_city_arrived_to_india, 'arrivedCountryCityIndia'),
              });

              setMetadata(metaMap);
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
   * Updates specific field value in state and tags it as manually verified.
   */
  const handleFieldChange = (field: keyof CompleteFormCFields, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setMetadata((prev) => ({
      ...prev,
      [field]: { confidence: 1.0, source: 'manual_edit' },
    }));
  };

  /**
   * Persists verified values back to SQLite and marks submission as 'REVIEWED'.
   */
  const handleSaveAndConfirm = async () => {
    try {
      setIsSaving(true);
      const db = await openDatabase();

      // Wrap values with metadata for consistency
      const outputPayload: Record<string, any> = {};
      (Object.keys(formData) as Array<keyof CompleteFormCFields>).forEach((k) => {
        const val = formData[k];
        const meta = metadata[k] || { confidence: 1.0, source: 'manual_verification' };
        outputPayload[k] = {
          value: val.trim() === '' ? null : val.trim(),
          confidence: meta.confidence,
          source: meta.source,
        };
      });

      // Persist full JSON into guest_documents table
      const updatedJson = JSON.stringify(outputPayload);
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
      default:
        return guestDoc.passport_bio_path || guestDoc.form_c_path;
    }
  };

  /**
   * Dynamically filters fields strictly matching the selected tab category.
   * If 'all' is active, renders every field grouped for portal submission.
   */
  const activeFieldsToRender = useMemo(() => {
    if (selectedDocTab === 'all') {
      return FIELD_REGISTRY;
    }
    if (selectedDocTab === 'photo') {
      return FIELD_REGISTRY.filter((f) => f.key === 'givenName' || f.key === 'surname');
    }
    return FIELD_REGISTRY.filter((f) => f.documentCategory === selectedDocTab);
  }, [selectedDocTab]);

  // Confidence badge color helper
  const renderConfidenceBadge = (fieldKey: keyof CompleteFormCFields) => {
    const meta = metadata[fieldKey] || { confidence: 0, source: 'unassigned' };
    const pct = Math.round(meta.confidence * 100);

    let badgeBg = '#FFEBEE';
    let badgeText = '#C62828';
    let label = `${pct}% Low`;

    if (meta.source === 'manual_edit' || meta.source === 'manual_verification') {
      badgeBg = '#E0F2FE';
      badgeText = '#0284C7';
      label = 'Edited ✍';
    } else if (meta.confidence >= 0.85) {
      badgeBg = '#E8F5E9';
      badgeText = '#2E7D32';
      label = `${pct}% High`;
    } else if (meta.confidence >= 0.50) {
      badgeBg = '#FFF8E1';
      badgeText = '#F57F17';
      label = `${pct}% Med`;
    }

    return (
      <View style={[styles.confidenceBadge, { backgroundColor: badgeBg }]}>
        <Text style={[styles.confidenceBadgeText, { color: badgeText }]}>{label}</Text>
      </View>
    );
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
                  {tabKey === 'form_c' ? 'FORM-C' : tabKey === 'all' ? '★ ALL' : tabKey.toUpperCase()}
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
                  source={{ uri: activeImage.startsWith('file://') ? activeImage : `file://${activeImage}` }}
                  style={styles.previewImage}
                  resizeMode="contain"
                />
              </ScrollView>
            ) : (
              <View style={styles.emptyImageContainer}>
                <Text style={[styles.emptyImageText, { color: colors.textMuted }]}>
                  No image scan attached for this document stage
                </Text>
              </View>
            )}
            <View style={styles.zoomHintBadge}>
              <Text style={styles.zoomHintText}>🔍 Pinch to zoom</Text>
            </View>
          </View>
        </View>

        {/* Bottom 58%: Strictly Isolated Form Fields Matching Active Tab */}
        <ScrollView contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
          <View style={styles.sectionHeaderRow}>
            <Text style={[styles.sectionHeading, { color: colors.primaryBrand }]}>
              {selectedDocTab === 'all'
                ? '★ Complete Form-C Master Record'
                : selectedDocTab === 'photo'
                ? '👤 Passport Portrait Verification'
                : `Extracted from ${selectedDocTab.toUpperCase()} Scan`}
            </Text>
            <Text style={[styles.sectionCountText, { color: colors.textMuted }]}>
              {activeFieldsToRender.length} Field(s)
            </Text>
          </View>

          {/* Render Only Fields Belonging to the Active Category */}
          {activeFieldsToRender.map((descriptor) => {
            const meta = metadata[descriptor.key] || { confidence: 0, source: 'unassigned' };
            return (
              <View style={styles.fieldGroup} key={descriptor.key}>
                <View style={styles.labelRow}>
                  <Text style={[styles.label, { color: colors.textMuted }]}>
                    {descriptor.label}
                  </Text>
                  {renderConfidenceBadge(descriptor.key)}
                </View>

                <TextInput
                  style={[
                    styles.input,
                    {
                      backgroundColor: colors.surface,
                      color: colors.textPrimary,
                      borderColor: colors.border,
                    },
                  ]}
                  value={formData[descriptor.key]}
                  onChangeText={(text) => handleFieldChange(descriptor.key, text)}
                  placeholder={descriptor.placeholder}
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize={descriptor.autoCapitalize || 'sentences'}
                />

                <Text style={styles.sourceCaption}>
                  Source: {meta.source}
                </Text>
              </View>
            );
          })}

          {/* Confirm & Save Button */}
          <TouchableOpacity
            disabled={isSaving}
            onPress={handleSaveAndConfirm}
            style={[styles.confirmButton, { backgroundColor: colors.statusReady }]}
          >
            {isSaving ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.confirmButtonText}>Save & Confirm Form-C Record ✓</Text>
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
    fontWeight: '700',
  },
  headerButton: {
    padding: 6,
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
    paddingHorizontal: 6,
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
    paddingHorizontal: 24,
  },
  emptyImageText: {
    fontSize: 13,
    textAlign: 'center',
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
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionHeading: {
    fontSize: 15,
    fontWeight: '700',
  },
  sectionCountText: {
    fontSize: 12,
    fontWeight: '500',
  },
  fieldGroup: {
    marginBottom: 14,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    flex: 1,
  },
  confidenceBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginLeft: 8,
  },
  confidenceBadgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  input: {
    height: 44,
    borderRadius: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    fontSize: 14,
  },
  sourceCaption: {
    fontSize: 10,
    color: '#94A3B8',
    marginTop: 2,
    textAlign: 'right',
  },
  confirmButton: {
    height: 50,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 18,
    marginBottom: 16,
  },
  confirmButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
  },
});

export default ReviewScreen;