import React, { useState } from 'react';
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
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { useAppTheme } from '../theme/ThemeContext';
import { insertSubmission, openDatabase, SubmissionRecord, GuestDocumentRecord } from '../db/database';
import { syncPendingUploads } from '../services/syncManager';

/**
 * Metadata definition for each of the 4 required document captures.
 */
interface DocumentStep {
  key: 'passport' | 'visa' | 'stamp' | 'form_c';
  title: string;
  description: string;
}

const DOCUMENT_STEPS: DocumentStep[] = [
  {
    key: 'passport',
    title: '1. Passport Bio-Data Page',
    description: 'Ensure the photo, full name, and machine-readable lines are clearly visible.',
  },
  {
    key: 'visa',
    title: '2. Visa Page or OCI Card',
    description: 'Capture the valid Indian entry visa stamp or OCI card details.',
  },
  {
    key: 'stamp',
    title: '3. Entry Immigration Stamp',
    description: 'Capture the stamped airport/seaport arrival date and port of entry.',
  },
  {
    key: 'form_c',
    title: '4. Form-C Arrival Report',
    description: 'Capture the physical handwritten arrival report sheet filled by the guest.',
  },
];

interface CaptureScreenProps {
  onCaptureComplete: () => void;
  onCancel: () => void;
}

export const CaptureScreen: React.FC<CaptureScreenProps> = ({ onCaptureComplete, onCancel }) => {
  // Theme context providing dynamic color tokens
  const { colors, isDark, toggleTheme } = useAppTheme();

  // Ingestion form state
  const [reference, setReference] = useState('');
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [capturedImages, setCapturedImages] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);

  const activeStep = DOCUMENT_STEPS[currentStepIndex];
  const activeImageUri = capturedImages[activeStep.key];

  /**
   * Launches the device camera to take a document photo.
   */
  const handleTakePhoto = async () => {
    const permissionResult = await ImagePicker.requestCameraPermissionsAsync();

    if (!permissionResult.granted) {
      Alert.alert('Permission Denied', 'Camera permission is required to capture guest documents.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
      allowsEditing: false,
    });

    if (!result.canceled && result.assets && result.assets.length > 0) {
      const selectedUri = result.assets[0].uri;
      setCapturedImages((prev) => ({
        ...prev,
        [activeStep.key]: selectedUri,
      }));
    }
  };

  /**
   * Copies captured images to permanent internal storage and creates
   * a local SQLite record in 'UPLOAD_PENDING' state.
   */
  const handleFinalizeSubmission = async () => {
    if (!capturedImages['passport']) {
      Alert.alert('Missing Document', 'Passport Bio page is strictly required.');
      return;
    }

    try {
      setIsSaving(true);
      const submissionId = `sub_${Date.now()}`;
      const docRecordId = `doc_${Date.now()}`;
      const now = new Date().toISOString();

      // Permanent directory inside app internal storage
      const docDir = `${FileSystem.documentDirectory}documents/${submissionId}/`;
      await FileSystem.makeDirectoryAsync(docDir, { intermediates: true });

      // Copy each image to internal storage to ensure offline permanence
      const persistedPaths: Record<string, string> = {};
      for (const [key, uri] of Object.entries(capturedImages)) {
        const destUri = `${docDir}${key}.jpg`;
        await FileSystem.copyAsync({ from: uri, to: destUri });
        persistedPaths[key] = destUri;
      }

      // Prepare Submission entity
      const newSubmission: SubmissionRecord = {
        id: submissionId,
        reference: reference.trim().length > 0 ? reference.trim() : undefined,
        guest_count: 1,
        status: 'UPLOAD_PENDING',
        created_at: now,
        updated_at: now,
      };

      // Prepare GuestDocument entity
      const newGuestDoc: GuestDocumentRecord = {
        id: docRecordId,
        submission_id: submissionId,
        guest_index: 0,
        passport_bio_path: persistedPaths['passport'],
        visa_stamp_path: persistedPaths['visa'],
        entry_stamp_path: persistedPaths['stamp'],
        form_c_path: persistedPaths['form_c'],
      };

      // 1. Insert into local SQLite database
      await insertSubmission(newSubmission, [newGuestDoc]);

      // 2. Trigger detached background upload without waiting
      syncPendingUploads().catch((err) =>
        console.warn('[CaptureScreen] Detached sync triggered with error:', err)
      );

      setIsSaving(false);
      onCaptureComplete();
    } catch (error: any) {
      setIsSaving(false);
      Alert.alert('Storage Error', error.message || 'Failed to save documents locally.');
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Top Header Bar */}
      <View style={[styles.headerBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={onCancel} style={styles.headerButton}>
          <Text style={[styles.headerButtonText, { color: colors.textMuted }]}>Cancel</Text>
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>Document Ingestion</Text>
        <TouchableOpacity onPress={toggleTheme} style={styles.themeToggle}>
          <Text style={styles.themeToggleText}>{isDark ? '☀️' : '🌙'}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Optional Booking Reference Input */}
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.fieldLabel, { color: colors.textPrimary }]}>
            Guest Name or Booking Reference (Optional)
          </Text>
          <TextInput
            style={[
              styles.textInput,
              {
                backgroundColor: colors.surfaceSubtle,
                color: colors.textPrimary,
                borderColor: colors.border,
              },
            ]}
            placeholder="e.g. John Doe / Room 201"
            placeholderTextColor={colors.textMuted}
            value={reference}
            onChangeText={setReference}
          />
        </View>

        {/* Guided Step Indicator */}
        <View style={styles.stepIndicatorContainer}>
          {DOCUMENT_STEPS.map((step, idx) => {
            const isCompleted = !!capturedImages[step.key];
            const isCurrent = idx === currentStepIndex;
            return (
              <TouchableOpacity
                key={step.key}
                onPress={() => setCurrentStepIndex(idx)}
                style={[
                  styles.stepBadge,
                  {
                    backgroundColor: isCurrent
                      ? colors.primaryBrand
                      : isCompleted
                      ? colors.statusReady
                      : colors.surfaceSubtle,
                    borderColor: colors.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.stepBadgeText,
                    { color: isCurrent || isCompleted ? '#FFFFFF' : colors.textMuted },
                  ]}
                >
                  {idx + 1}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Active Document Step Card */}
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.stepTitle, { color: colors.textPrimary }]}>{activeStep.title}</Text>
          <Text style={[styles.stepDescription, { color: colors.textMuted }]}>
            {activeStep.description}
          </Text>

          {/* Photo Preview Canvas */}
          <View
            style={[
              styles.previewContainer,
              { backgroundColor: colors.surfaceSubtle, borderColor: colors.border },
            ]}
          >
            {activeImageUri ? (
              <Image source={{ uri: activeImageUri }} style={styles.previewImage} resizeMode="contain" />
            ) : (
              <View style={styles.emptyPreview}>
                <Text style={[styles.emptyPreviewText, { color: colors.textMuted }]}>
                  No photo captured yet
                </Text>
              </View>
            )}
          </View>

          {/* Shutter / Retake Button */}
          <TouchableOpacity
            onPress={handleTakePhoto}
            style={[styles.cameraButton, { backgroundColor: colors.accent }]}
          >
            <Text style={styles.cameraButtonText}>
              {activeImageUri ? 'Retake Photo' : 'Snap Photo'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Stepper Navigation Actions */}
        <View style={styles.navigationRow}>
          <TouchableOpacity
            disabled={currentStepIndex === 0}
            onPress={() => setCurrentStepIndex((prev) => prev - 1)}
            style={[
              styles.navButton,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
                opacity: currentStepIndex === 0 ? 0.4 : 1,
              },
            ]}
          >
            <Text style={[styles.navButtonText, { color: colors.textPrimary }]}>Previous</Text>
          </TouchableOpacity>

          {currentStepIndex < DOCUMENT_STEPS.length - 1 ? (
            <TouchableOpacity
              onPress={() => setCurrentStepIndex((prev) => prev + 1)}
              style={[styles.navButton, { backgroundColor: colors.primaryBrand }]}
            >
              <Text style={styles.navButtonPrimaryText}>Next Document</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              disabled={isSaving}
              onPress={handleFinalizeSubmission}
              style={[styles.navButton, { backgroundColor: colors.statusReady }]}
            >
              {isSaving ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.navButtonPrimaryText}>Save & Ingest</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
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
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  card: {
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 8,
  },
  textInput: {
    height: 48,
    borderRadius: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    fontSize: 15,
  },
  stepIndicatorContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
    paddingHorizontal: 16,
  },
  stepBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  stepBadgeText: {
    fontSize: 16,
    fontWeight: '700',
  },
  stepTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  stepDescription: {
    fontSize: 13,
    marginBottom: 16,
    lineHeight: 18,
  },
  previewContainer: {
    height: 240,
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  emptyPreview: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyPreviewText: {
    fontSize: 14,
  },
  cameraButton: {
    height: 48,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  navigationRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  navButton: {
    flex: 0.48,
    height: 48,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  navButtonText: {
    fontSize: 15,
    fontWeight: '500',
  },
  navButtonPrimaryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
});