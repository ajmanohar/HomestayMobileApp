// ==============================================================================
// ReviewScreen.tsx - HomestayMobileApp (React Native / Expo SDK 57)
// ==============================================================================
// Verification and review screen with pinch-to-zoom image inspection and
// editable Form-C field inputs.
//
// Lifecycle Constraints (Task 43):
// - Mobile application lifecycle ends strictly at Review & Re-submit.
// - Portal auto-submission is removed from mobile.
//
// Features:
// - Task 42: Dual Visa inspection tabs (e-Visa Document vs. Passport Visa Stamp).
// - Task 44: Mobile-Triggered Deletion with cascade purge to Dell edge server.
// - Task 45: Isolated per-document field viewing and editing.
// - Task 48: Explicit (DD-MM-YYYY) labels on every date field and guaranteed
//   persistence of manual operator overrides into SQLite.
// ==============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Image,
  Alert,
  ActivityIndicator,
  SafeAreaView,
  Dimensions,
} from 'react-native';
import { useAppTheme } from '../theme/ThemeContext';
import {
  openDatabase,
  getSubmissionById,
  updateGuestExtractedData,
  updateSubmissionStatus,
  deleteSubmissionLocallyAndRemote,
  GuestDocumentRecord,
  SubmissionRecord,
} from '../db/database';
import { submitPassportBio, attachDocumentToJob, startJobProcessing } from '../services/apiService';

interface ReviewScreenProps {
  submissionId: string;
  onBack: () => void;
  onComplete: () => void;
}

type ActiveDocTab = 'passport' | 'visa_document' | 'visa_stamp' | 'stamp' | 'form_c' | 'photo' | 'all';

interface FormCData {
  // Bio fields
  surname: string;
  givenNames: string;
  sex: string;
  dateOfBirth: string;
  nationality: string;
  passportNumber: string;
  passportExpiryDate: string;

  // Visa fields
  visaNumber: string;
  visaType: string;
  visaIssueDate: string;
  visaExpiryDate: string;
  visaPlaceOfIssue: string;

  // Entry stamp fields
  arrivalDateIndia: string;
  arrivalPortIndia: string;

  // Form-C slip fields (Rows 1-12)
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

const INITIAL_FORM_DATA: FormCData = {
  surname: '',
  givenNames: '',
  sex: '',
  dateOfBirth: '',
  nationality: '',
  passportNumber: '',
  passportExpiryDate: '',
  visaNumber: '',
  visaType: 'TOURIST',
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
  purposeOfVisit: 'Tourist',
  expectedDepartureDate: '',
  arrivedCountryCityIndia: '',
};

export const ReviewScreen: React.FC<ReviewScreenProps> = ({
  submissionId,
  onBack,
  onComplete,
}) => {
  const { colors, isDark } = useAppTheme();

  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [reSubmitting, setReSubmitting] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);

  const [submission, setSubmission] = useState<SubmissionRecord | null>(null);
  const [guestDoc, setGuestDoc] = useState<GuestDocumentRecord | null>(null);
  const [formData, setFormData] = useState<FormCData>(INITIAL_FORM_DATA);
  const [selectedDocTab, setSelectedDocTab] = useState<ActiveDocTab>('passport');

  /**
   * Helper function to extract text values whether flat or wrapped in { value, confidence }.
   */
  const extractVal = (field: any, fallback: string = ''): string => {
    if (field === null || field === undefined) return fallback;
    if (typeof field === 'object' && 'value' in field) {
      return field.value !== null && field.value !== undefined ? String(field.value) : fallback;
    }
    return String(field);
  };

  /**
   * Loads submission metadata and guest documents from SQLite.
   */
  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const sub = await getSubmissionById(submissionId);
      setSubmission(sub);

      const db = await openDatabase();
      const docs = await db.getAllAsync<GuestDocumentRecord>(
        'SELECT * FROM guest_documents WHERE submission_id = ? ORDER BY guest_index ASC LIMIT 1;',
        [submissionId]
      );

      if (docs && docs.length > 0) {
        const doc = docs[0];
        setGuestDoc(doc);

        if (doc.extracted_data_json) {
          try {
            const parsed = JSON.parse(doc.extracted_data_json);

            // Check if backend returned isolated containers (Task 45) or flat structure
            const docsContainer = parsed.documents || {};
            const pBio = docsContainer.passport_bio || parsed;
            const vDoc = docsContainer.visa_document || parsed;
            const vStamp = docsContainer.visa_stamp || parsed;
            const eStamp = docsContainer.entry_stamp || parsed;
            const wForm = docsContainer.welcome_form || parsed;

            setFormData({
              // Passport Bio
              surname: extractVal(pBio.surname),
              givenNames: extractVal(pBio.given_names),
              sex: extractVal(pBio.sex),
              dateOfBirth: extractVal(pBio.date_of_birth),
              nationality: extractVal(pBio.nationality),
              passportNumber: extractVal(pBio.passport_number),
              passportExpiryDate: extractVal(pBio.passport_expiry_date),

              // Visa (prefer visa_document then visa_stamp then flat)
              visaNumber: extractVal(vDoc.visa_number || vStamp.visa_number || parsed.visa_number),
              visaType: extractVal(vDoc.visa_type || vStamp.visa_type || parsed.visa_type, 'TOURIST'),
              visaIssueDate: extractVal(vDoc.visa_issue_date || vStamp.visa_issue_date || parsed.visa_issue_date),
              visaExpiryDate: extractVal(vDoc.visa_expiry_date || vStamp.visa_expiry_date || parsed.visa_expiry_date),
              visaPlaceOfIssue: extractVal(vDoc.visa_place_of_issue || vStamp.visa_place_of_issue || parsed.visa_place_of_issue),

              // Entry Stamp
              arrivalDateIndia: extractVal(eStamp.arrival_date_india || parsed.arrival_date_india),
              arrivalPortIndia: extractVal(eStamp.arrival_port_india || parsed.arrival_port_india),

              // Form-C Report (Rows 1-12)
              permanentAddress: extractVal(wForm.permanent_address || parsed.permanent_address),
              city: extractVal(wForm.city || parsed.city),
              country: extractVal(wForm.country || parsed.country),
              contactEmail: extractVal(wForm.contact_email || parsed.contact_email),
              contactPhone: extractVal(wForm.contact_phone || parsed.contact_phone),
              arrivalDatetimeHomestay: extractVal(wForm.arrival_datetime_homestay || parsed.arrival_datetime_homestay),
              arrivedFrom: extractVal(wForm.arrived_from || parsed.arrived_from),
              proceedingTo: extractVal(wForm.proceeding_to || parsed.proceeding_to),
              stayDurationIndia: extractVal(wForm.stay_duration_india || parsed.stay_duration_india),
              purposeOfVisit: extractVal(wForm.purpose_of_visit || parsed.purpose_of_visit, 'Tourist'),
              expectedDepartureDate: extractVal(wForm.expected_departure_date || parsed.expected_departure_date),
              arrivedCountryCityIndia: extractVal(wForm.arrived_country_city_india || parsed.arrived_country_city_india),
            });
          } catch (jsonErr) {
            console.warn('[ReviewScreen] Error parsing extracted_data_json:', jsonErr);
          }
        }
      }
    } catch (err) {
      console.warn('[ReviewScreen] Error loading data:', err);
      Alert.alert('Load Error', 'Failed to retrieve submission details.');
    } finally {
      setLoading(false);
    }
  }, [submissionId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  /**
   * Resolves the active image URI based on the selected document tab.
   */
  const getActiveImageUri = (): string | null => {
    if (!guestDoc) return null;
    switch (selectedDocTab) {
      case 'passport':
        return guestDoc.passport_bio_path ?? null;
      case 'visa_document':
        return (guestDoc.visa_document_path || guestDoc.visa_stamp_path) ?? null;
      case 'visa_stamp':
        return (guestDoc.visa_stamp_path || guestDoc.visa_document_path) ?? null;
      case 'stamp':
        return guestDoc.entry_stamp_path ?? null;
      case 'form_c':
        return guestDoc.form_c_path ?? null;
      case 'photo':
        return guestDoc.guest_photo_path ?? null;
      case 'all':
      default:
        return guestDoc.passport_bio_path ?? null;
    }
  };

  /**
   * Updates an individual field value in the local state.
   */
  const updateField = (key: keyof FormCData, value: string) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * Task 48: Overwrites AI data with manual operator edits and persists to SQLite.
   */
  const handleSave = async (showNotice: boolean = true) => {
    try {
      setSaving(true);
      const updatedPayload = {
        surname: { value: formData.surname, confidence: 1.0, source: 'manual_edit' },
        given_names: { value: formData.givenNames, confidence: 1.0, source: 'manual_edit' },
        sex: { value: formData.sex, confidence: 1.0, source: 'manual_edit' },
        date_of_birth: { value: formData.dateOfBirth, confidence: 1.0, source: 'manual_edit' },
        nationality: { value: formData.nationality, confidence: 1.0, source: 'manual_edit' },
        passport_number: { value: formData.passportNumber, confidence: 1.0, source: 'manual_edit' },
        passport_expiry_date: { value: formData.passportExpiryDate, confidence: 1.0, source: 'manual_edit' },
        visa_number: { value: formData.visaNumber, confidence: 1.0, source: 'manual_edit' },
        visa_type: { value: formData.visaType, confidence: 1.0, source: 'manual_edit' },
        visa_issue_date: { value: formData.visaIssueDate, confidence: 1.0, source: 'manual_edit' },
        visa_expiry_date: { value: formData.visaExpiryDate, confidence: 1.0, source: 'manual_edit' },
        visa_place_of_issue: { value: formData.visaPlaceOfIssue, confidence: 1.0, source: 'manual_edit' },
        arrival_date_india: { value: formData.arrivalDateIndia, confidence: 1.0, source: 'manual_edit' },
        arrival_port_india: { value: formData.arrivalPortIndia, confidence: 1.0, source: 'manual_edit' },
        permanent_address: { value: formData.permanentAddress, confidence: 1.0, source: 'manual_edit' },
        city: { value: formData.city, confidence: 1.0, source: 'manual_edit' },
        country: { value: formData.country, confidence: 1.0, source: 'manual_edit' },
        contact_email: { value: formData.contactEmail, confidence: 1.0, source: 'manual_edit' },
        contact_phone: { value: formData.contactPhone, confidence: 1.0, source: 'manual_edit' },
        arrival_datetime_homestay: { value: formData.arrivalDatetimeHomestay, confidence: 1.0, source: 'manual_edit' },
        arrived_from: { value: formData.arrivedFrom, confidence: 1.0, source: 'manual_edit' },
        proceeding_to: { value: formData.proceedingTo, confidence: 1.0, source: 'manual_edit' },
        stay_duration_india: { value: formData.stayDurationIndia, confidence: 1.0, source: 'manual_edit' },
        purpose_of_visit: { value: formData.purposeOfVisit, confidence: 1.0, source: 'manual_edit' },
        expected_departure_date: { value: formData.expectedDepartureDate, confidence: 1.0, source: 'manual_edit' },
        arrived_country_city_india: { value: formData.arrivedCountryCityIndia, confidence: 1.0, source: 'manual_edit' },
        // Maintain per-document container structure with manual overrides
        documents: {
          passport_bio: {
            surname: { value: formData.surname, confidence: 1.0, source: 'manual_edit' },
            given_names: { value: formData.givenNames, confidence: 1.0, source: 'manual_edit' },
            sex: { value: formData.sex, confidence: 1.0, source: 'manual_edit' },
            date_of_birth: { value: formData.dateOfBirth, confidence: 1.0, source: 'manual_edit' },
            nationality: { value: formData.nationality, confidence: 1.0, source: 'manual_edit' },
            passport_number: { value: formData.passportNumber, confidence: 1.0, source: 'manual_edit' },
            passport_expiry_date: { value: formData.passportExpiryDate, confidence: 1.0, source: 'manual_edit' },
          },
          visa_stamp: {
            visa_number: { value: formData.visaNumber, confidence: 1.0, source: 'manual_edit' },
            visa_type: { value: formData.visaType, confidence: 1.0, source: 'manual_edit' },
            visa_issue_date: { value: formData.visaIssueDate, confidence: 1.0, source: 'manual_edit' },
            visa_expiry_date: { value: formData.visaExpiryDate, confidence: 1.0, source: 'manual_edit' },
            visa_place_of_issue: { value: formData.visaPlaceOfIssue, confidence: 1.0, source: 'manual_edit' },
          },
          entry_stamp: {
            arrival_date_india: { value: formData.arrivalDateIndia, confidence: 1.0, source: 'manual_edit' },
            arrival_port_india: { value: formData.arrivalPortIndia, confidence: 1.0, source: 'manual_edit' },
          },
          welcome_form: {
            permanent_address: { value: formData.permanentAddress, confidence: 1.0, source: 'manual_edit' },
            city: { value: formData.city, confidence: 1.0, source: 'manual_edit' },
            country: { value: formData.country, confidence: 1.0, source: 'manual_edit' },
            contact_email: { value: formData.contactEmail, confidence: 1.0, source: 'manual_edit' },
            contact_phone: { value: formData.contactPhone, confidence: 1.0, source: 'manual_edit' },
            arrival_datetime_homestay: { value: formData.arrivalDatetimeHomestay, confidence: 1.0, source: 'manual_edit' },
            arrived_from: { value: formData.arrivedFrom, confidence: 1.0, source: 'manual_edit' },
            proceeding_to: { value: formData.proceedingTo, confidence: 1.0, source: 'manual_edit' },
            stay_duration_india: { value: formData.stayDurationIndia, confidence: 1.0, source: 'manual_edit' },
            purpose_of_visit: { value: formData.purposeOfVisit, confidence: 1.0, source: 'manual_edit' },
            expected_departure_date: { value: formData.expectedDepartureDate, confidence: 1.0, source: 'manual_edit' },
            arrived_country_city_india: { value: formData.arrivedCountryCityIndia, confidence: 1.0, source: 'manual_edit' },
          },
        },
      };

      await updateGuestExtractedData(submissionId, JSON.stringify(updatedPayload));
      await updateSubmissionStatus(submissionId, 'REVIEWED');

      if (showNotice) {
        Alert.alert('Saved', 'Guest Form-C details successfully updated locally and ready for desktop retrieval.');
      }
    } catch (err: any) {
      Alert.alert('Save Failed', err.message || 'Could not save guest record.');
    } finally {
      setSaving(false);
    }
  };

  /**
   * Re-submits images to the Dell server for fresh background extraction.
   */
  const handleReSubmit = async () => {
    if (!guestDoc || !guestDoc.passport_bio_path) {
      Alert.alert('Error', 'Passport bio image is required to initiate extraction.');
      return;
    }

    try {
      setReSubmitting(true);
      const submitRes = await submitPassportBio(guestDoc.passport_bio_path);
      const newJobId = submitRes.job_id;

      if (guestDoc.visa_document_path) {
        await attachDocumentToJob(newJobId, 'visa_document', guestDoc.visa_document_path);
      }
      if (guestDoc.visa_stamp_path) {
        await attachDocumentToJob(newJobId, 'visa_stamp', guestDoc.visa_stamp_path);
      }
      if (guestDoc.entry_stamp_path) {
        await attachDocumentToJob(newJobId, 'entry_stamp', guestDoc.entry_stamp_path);
      }
      if (guestDoc.form_c_path) {
        await attachDocumentToJob(newJobId, 'welcome_form', guestDoc.form_c_path);
      }
      if (guestDoc.guest_photo_path) {
        await attachDocumentToJob(newJobId, 'guest_photo', guestDoc.guest_photo_path);
      }

      await startJobProcessing(newJobId);

      const db = await openDatabase();
      await db.runAsync('UPDATE submissions SET status = ?, job_id = ? WHERE id = ?;', [
        'PROCESSING',
        newJobId,
        submissionId,
      ]);
      await db.runAsync('UPDATE guest_documents SET extracted_data_json = NULL WHERE submission_id = ?;', [
        submissionId,
      ]);

      Alert.alert(
        'Re-Submitted',
        'Documents re-submitted to the server. Processing has restarted.',
        [{ text: 'OK', onPress: onComplete }]
      );
    } catch (err: any) {
      Alert.alert('Re-submission Error', err.message || 'Failed to dispatch to server.');
    } finally {
      setReSubmitting(false);
    }
  };

  /**
   * Permanently deletes submission on mobile and cascades purge on Dell edge server (Task 44).
   */
  const handleDeleteSubmission = () => {
    Alert.alert(
      'Delete Submission',
      'Are you sure you want to delete this submission? All captured images and extracted records will be permanently removed from this device and the server.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              setDeleting(true);
              await deleteSubmissionLocallyAndRemote(submissionId);
              Alert.alert('Deleted', 'Submission and associated files permanently purged.', [
                { text: 'OK', onPress: onComplete },
              ]);
            } catch (err: any) {
              Alert.alert('Delete Failed', err.message || 'Could not delete submission.');
            } finally {
              setDeleting(false);
            }
          },
        },
      ]
    );
  };

  /**
   * Concludes the mobile lifecycle (Task 43: Review & Re-submit only).
   */
  const handleCompleteReview = async () => {
    await handleSave(false);
    onComplete();
  };

  // Helper to render an outlined editable text input with explicit format hints
  const renderField = (label: string, fieldKey: keyof FormCData, placeholder: string = '') => (
    <View style={styles.fieldContainer} key={fieldKey}>
      <Text style={[styles.fieldLabel, { color: colors.textMuted }]}>{label}</Text>
      <TextInput
        style={[
          styles.fieldInput,
          {
            color: colors.textPrimary,
            backgroundColor: isDark ? '#1E293B' : '#F8FAFC',
            borderColor: colors.border,
          },
        ]}
        value={formData[fieldKey]}
        onChangeText={(text) => updateField(fieldKey, text)}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
      />
    </View>
  );

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primaryBrand} />
        <Text style={[styles.loadingText, { color: colors.textPrimary }]}>Loading submission...</Text>
      </View>
    );
  }

  const activeImageUri = getActiveImageUri();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* --- Header Bar --- */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={[styles.backButtonText, { color: colors.primaryBrand }]}>← Back</Text>
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>Review & Verify</Text>
        <TouchableOpacity
          onPress={handleDeleteSubmission}
          style={styles.deleteHeaderButton}
          disabled={deleting}
        >
          {deleting ? (
            <ActivityIndicator size="small" color="#EF4444" />
          ) : (
            <Text style={styles.deleteHeaderText}>🗑 Delete</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* --- Top 38%: Pinch-to-Zoom Document Preview --- */}
      <View style={[styles.imageViewerPane, { backgroundColor: isDark ? '#000000' : '#F1F5F9' }]}>
        {activeImageUri ? (
          <ScrollView
            maximumZoomScale={4.0}
            minimumZoomScale={1.0}
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.zoomContent}
          >
            <Image source={{ uri: activeImageUri }} style={styles.previewImage} resizeMode="contain" />
          </ScrollView>
        ) : (
          <View style={styles.noImagePlaceholder}>
            <Text style={[styles.noImageText, { color: colors.textMuted }]}>
              No document image attached for this section.
            </Text>
          </View>
        )}
        <View style={styles.zoomHintBadge}>
          <Text style={styles.zoomHintText}>🔍 Pinch to zoom</Text>
        </View>
      </View>

      {/* --- Document Selector Tabs (Task 42: Dual Visa Support) --- */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[styles.tabsBar, { backgroundColor: colors.surface }]}
        contentContainerStyle={styles.tabsContainer}
      >
        <TouchableOpacity
          style={[styles.tabButton, selectedDocTab === 'passport' && { backgroundColor: colors.primaryBrand }]}
          onPress={() => setSelectedDocTab('passport')}
        >
          <Text style={[styles.tabButtonText, selectedDocTab === 'passport' ? styles.tabActiveText : { color: colors.textMuted }]}>
            Passport
          </Text>
        </TouchableOpacity>

        {guestDoc?.visa_document_path && (
          <TouchableOpacity
            style={[styles.tabButton, selectedDocTab === 'visa_document' && { backgroundColor: colors.primaryBrand }]}
            onPress={() => setSelectedDocTab('visa_document')}
          >
            <Text style={[styles.tabButtonText, selectedDocTab === 'visa_document' ? styles.tabActiveText : { color: colors.textMuted }]}>
              Visa Doc (A4)
            </Text>
          </TouchableOpacity>
        )}

        {guestDoc?.visa_stamp_path && (
          <TouchableOpacity
            style={[styles.tabButton, selectedDocTab === 'visa_stamp' && { backgroundColor: colors.primaryBrand }]}
            onPress={() => setSelectedDocTab('visa_stamp')}
          >
            <Text style={[styles.tabButtonText, selectedDocTab === 'visa_stamp' ? styles.tabActiveText : { color: colors.textMuted }]}>
              Visa Stamp
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={[styles.tabButton, selectedDocTab === 'stamp' && { backgroundColor: colors.primaryBrand }]}
          onPress={() => setSelectedDocTab('stamp')}
        >
          <Text style={[styles.tabButtonText, selectedDocTab === 'stamp' ? styles.tabActiveText : { color: colors.textMuted }]}>
            Entry Stamp
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabButton, selectedDocTab === 'form_c' && { backgroundColor: colors.primaryBrand }]}
          onPress={() => setSelectedDocTab('form_c')}
        >
          <Text style={[styles.tabButtonText, selectedDocTab === 'form_c' ? styles.tabActiveText : { color: colors.textMuted }]}>
            Form-C Slip
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabButton, selectedDocTab === 'all' && { backgroundColor: colors.primaryBrand }]}
          onPress={() => setSelectedDocTab('all')}
        >
          <Text style={[styles.tabButtonText, selectedDocTab === 'all' ? styles.tabActiveText : { color: colors.textMuted }]}>
            All Fields
          </Text>
        </TouchableOpacity>
      </ScrollView>

      {/* --- Bottom 60%: Tab-Scoped Editable Form Fields with Explicit Date Labels (Task 48) --- */}
      <ScrollView style={styles.fieldsScroll} contentContainerStyle={styles.fieldsContainer}>
        {/* PASSPORT FIELDS */}
        {(selectedDocTab === 'passport' || selectedDocTab === 'all') && (
          <View style={styles.formSection}>
            <Text style={[styles.sectionHeading, { color: colors.primaryBrand }]}>Passport Bio-Data</Text>
            {renderField('Surname (Family Name)', 'surname', 'e.g. DOE')}
            {renderField('Given Name(s)', 'givenNames', 'e.g. JOHN')}
            {renderField('Passport Number', 'passportNumber', 'e.g. C92PJR1W2')}
            {renderField('Nationality', 'nationality', 'e.g. DEUTSCH or GERMANY')}
            {renderField('Date of Birth (DD-MM-YYYY)', 'dateOfBirth', 'DD-MM-YYYY')}
            {renderField('Sex (M / F / X)', 'sex', 'M, F, or X')}
            {renderField('Passport Expiry Date (DD-MM-YYYY)', 'passportExpiryDate', 'DD-MM-YYYY')}
          </View>
        )}

        {/* VISA FIELDS (Task 42) */}
        {(selectedDocTab === 'visa_document' || selectedDocTab === 'visa_stamp' || selectedDocTab === 'all') && (
          <View style={styles.formSection}>
            <Text style={[styles.sectionHeading, { color: colors.primaryBrand }]}>
              {selectedDocTab === 'visa_document' ? 'e-Visa Document Details' : 'Visa Stamp / Sticker Details'}
            </Text>
            {renderField('Visa Number', 'visaNumber', 'e.g. H26V04876')}
            {renderField('Visa Type', 'visaType', 'TOURIST, BUSINESS, etc.')}
            {renderField('Visa Issue Date (DD-MM-YYYY)', 'visaIssueDate', 'DD-MM-YYYY')}
            {renderField('Visa Expiry Date (DD-MM-YYYY)', 'visaExpiryDate', 'DD-MM-YYYY')}
            {renderField('Place of Issue / Authority', 'visaPlaceOfIssue', 'e.g. Berlin or Online')}
          </View>
        )}

        {/* ENTRY STAMP FIELDS */}
        {(selectedDocTab === 'stamp' || selectedDocTab === 'all') && (
          <View style={styles.formSection}>
            <Text style={[styles.sectionHeading, { color: colors.primaryBrand }]}>Immigration Arrival Stamp</Text>
            {renderField('Date of Arrival in India (DD-MM-YYYY)', 'arrivalDateIndia', 'DD-MM-YYYY')}
            {renderField('Port or Airport of Arrival', 'arrivalPortIndia', 'e.g. COCHIN AIRPORT, MUMBAI')}
          </View>
        )}

        {/* FORM-C HANDWRITTEN SLIP FIELDS (Rows 1-12) */}
        {(selectedDocTab === 'form_c' || selectedDocTab === 'all') && (
          <View style={styles.formSection}>
            <Text style={[styles.sectionHeading, { color: colors.primaryBrand }]}>Form-C Arrival Report (Rows 1-12)</Text>
            {renderField('Row 2: Full Permanent Street Address', 'permanentAddress', 'Street address in home country')}
            {renderField('Row 2: Home City / Town', 'city', 'Foreign city')}
            {renderField('Row 2: Home Country', 'country', 'Foreign country')}
            {renderField('Row 2: Contact Email', 'contactEmail', 'guest@example.com')}
            {renderField('Row 2: Telephone / Mobile', 'contactPhone', '+49 ...')}
            {renderField('Row 6: Date & Time of Arrival in Homestay (DD-MM-YYYY HH:MM)', 'arrivalDatetimeHomestay', 'DD-MM-YYYY HH:MM')}
            {renderField('Row 7: Arrived From', 'arrivedFrom', 'Previous city / country')}
            {renderField('Row 8: Proceeding To', 'proceedingTo', 'Next destination')}
            {renderField('Row 9: Proposed Stay Duration in India', 'stayDurationIndia', 'e.g. 1 month, 2 weeks')}
            {renderField('Row 10: Purpose of Visit & Profession', 'purposeOfVisit', 'Tourist, Business, etc.')}
            {renderField('Row 11: Expected Date of Departure (DD-MM-YYYY)', 'expectedDepartureDate', 'DD-MM-YYYY')}
            {renderField('Row 12: Country & City Arrived to India', 'arrivedCountryCityIndia', 'e.g. Germany, Munich')}
          </View>
        )}
      </ScrollView>

      {/* --- Action Bar (Task 43: Review & Re-Submit Only - Portal Submit Removed) --- */}
      <View style={[styles.actionBar, { borderTopColor: colors.border, backgroundColor: colors.background }]}>
        <TouchableOpacity
          style={[styles.reSubmitButton, { borderColor: colors.primaryBrand }]}
          onPress={handleReSubmit}
          disabled={reSubmitting}
        >
          {reSubmitting ? (
            <ActivityIndicator size="small" color={colors.primaryBrand} />
          ) : (
            <Text style={[styles.reSubmitButtonText, { color: colors.primaryBrand }]}>⟳ Re-submit</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.saveButton, { backgroundColor: isDark ? '#334155' : '#E2E8F0' }]}
          onPress={() => handleSave(true)}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator size="small" color={colors.textPrimary} />
          ) : (
            <Text style={[styles.saveButtonText, { color: colors.textPrimary }]}>💾 Save</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.completeButton, { backgroundColor: colors.primaryBrand }]}
          onPress={handleCompleteReview}
        >
          <Text style={styles.completeButtonText}>✓ Done</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  backButton: {
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  backButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  deleteHeaderButton: {
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  deleteHeaderText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#EF4444',
  },
  imageViewerPane: {
    height: Dimensions.get('window').height * 0.38,
    position: 'relative',
    overflow: 'hidden',
  },
  zoomContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  previewImage: {
    width: Dimensions.get('window').width,
    height: '100%',
  },
  noImagePlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  noImageText: {
    fontSize: 14,
    textAlign: 'center',
  },
  zoomHintBadge: {
    position: 'absolute',
    bottom: 8,
    right: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  zoomHintText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '500',
  },
  tabsBar: {
    maxHeight: 48,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.06)',
  },
  tabsContainer: {
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  tabButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 8,
    backgroundColor: 'rgba(0,0,0,0.04)',
  },
  tabButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  tabActiveText: {
    color: '#FFFFFF',
  },
  fieldsScroll: {
    flex: 1,
  },
  fieldsContainer: {
    padding: 16,
    paddingBottom: 32,
  },
  formSection: {
    marginBottom: 20,
  },
  sectionHeading: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fieldContainer: {
    marginBottom: 14,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  fieldInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  actionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    gap: 8,
  },
  reSubmitButton: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reSubmitButtonText: {
    fontSize: 14,
    fontWeight: '700',
  },
  saveButton: {
    flex: 1,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonText: {
    fontSize: 14,
    fontWeight: '700',
  },
  completeButton: {
    flex: 1.2,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  completeButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
});

export default ReviewScreen;