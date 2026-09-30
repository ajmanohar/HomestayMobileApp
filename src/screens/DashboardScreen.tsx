import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useAppTheme } from '../theme/ThemeContext';
import { getAllSubmissions, openDatabase, updateSubmissionStatus, SubmissionRecord, GuestDocumentRecord, SubmissionStatus } from '../db/database';
import { runFullSync } from '../services/syncManager';
import { submitGuestDocuments } from '../services/apiService';

interface DashboardScreenProps {
  onStartNewCapture: () => void;
  onOpenReview: (submissionId: string) => void;
  onOpenPortal: (submissionId: string) => void;
}

export const DashboardScreen: React.FC<DashboardScreenProps> = ({
  onStartNewCapture,
  onOpenReview,
  onOpenPortal,
}) => {
  const { colors, isDark, toggleTheme } = useAppTheme();

  // Screen state
  const [submissions, setSubmissions] = useState<SubmissionRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  /**
   * Queries local SQLite database to load recent guest submissions.
   */
  const loadSubmissions = useCallback(async () => {
    try {
      const records = await getAllSubmissions();
      setSubmissions(records);
    } catch (error) {
      console.warn('[Dashboard] Error querying submissions from SQLite:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Pull-to-refresh handler: runs sync runner against backend API,
   * then reloads local database rows.
   */
  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      console.log('[Dashboard] Manual pull-to-refresh triggered.');
      await runFullSync();
      await loadSubmissions();
    } catch (error: any) {
      console.warn('[Dashboard] Pull-to-refresh error:', error);
      Alert.alert('Sync Notice', error.message || 'Unable to sync with remote server.');
    } finally {
      setRefreshing(false);
    }
  };

  /**
   * Allows manual single-card retry when a submission is stuck in UPLOAD_PENDING.
   *
   * @param item - The target submission record to retry
   */
  const handleRetryUpload = async (item: SubmissionRecord) => {
    if (!item || !item.id) {
      Alert.alert('Error', 'Invalid submission record ID.');
      return;
    }

    try {
      setRetryingId(item.id);
      console.log(`[Dashboard] Starting retry upload for submission ID: ${item.id}`);

      const db = await openDatabase();
      const safeSubmissionId = String(item.id).trim();

      // 1. Fetch document record associated with this submission
      const docs = await db.getAllAsync<GuestDocumentRecord>(
        'SELECT * FROM guest_documents WHERE submission_id = ? LIMIT 1;',
        [safeSubmissionId]
      );

      if (!docs || docs.length === 0) {
        Alert.alert('Error', 'No document images found for this submission.');
        return;
      }

      const guestDoc = docs[0];
      console.log(`[Dashboard] Found document: ${guestDoc.passport_bio_path}`);

      // 2. Post multipart upload to backend API (guest_photo remains local on-device)
      const response = await submitGuestDocuments(
        guestDoc.passport_bio_path,
        guestDoc.visa_stamp_path ?? undefined,
        guestDoc.entry_stamp_path ?? undefined,
        guestDoc.form_c_path ?? undefined,
        item.reference ?? undefined
      );

      console.log(`[Dashboard] Upload succeeded with job_id: ${response.job_id}`);

      // 3. On success, advance status to PROCESSING with returned job_id
      await updateSubmissionStatus(safeSubmissionId, 'PROCESSING', response.job_id);
      await loadSubmissions();

      Alert.alert(
        'Upload Successful',
        `Job registered on server with ID: ${response.job_id}. Processing has started.`
      );
    } catch (error: any) {
      console.error(`[Dashboard] Retry upload failed for ${item.id}:`, error);
      Alert.alert(
        'Upload Failed',
        `Server communication failed: ${error.message || error}.\n\nPlease ensure your server and Cloudflare tunnel are active, then tap to retry.`
      );
    } finally {
      setRetryingId(null);
    }
  };

  // Initial mount load
  useEffect(() => {
    loadSubmissions();
  }, [loadSubmissions]);

  /**
   * Semantic badge visual configuration.
   */
  const getStatusBadgeStyle = (status: SubmissionStatus) => {
    switch (status) {
      case 'UPLOAD_PENDING':
        return { backgroundColor: colors.statusPending, label: 'Upload Pending' };
      case 'PROCESSING':
        return { backgroundColor: colors.statusProcess, label: 'Processing' };
      case 'PENDING_REVIEW':
        return { backgroundColor: colors.statusReady, label: 'Ready for Review' };
      case 'REVIEWED':
        return { backgroundColor: colors.statusDone, label: 'Reviewed' };
      default:
        return { backgroundColor: colors.textMuted, label: status };
    }
  };

  /**
   * Formats ISO timestamp into readable date and time.
   */
  const formatDate = (isoString: string): string => {
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  /**
   * Card press router:
   * - If REVIEWED: opens the Form-C portal runner screen.
   * - If PENDING_REVIEW: opens split-screen verification.
   * - If UPLOAD_PENDING: triggers immediate retry upload.
   */
  const handleCardPress = (item: SubmissionRecord) => {
    if (item.status === 'REVIEWED') {
      onOpenPortal(item.id);
    } else if (item.status === 'PENDING_REVIEW') {
      onOpenReview(item.id);
    } else if (item.status === 'UPLOAD_PENDING') {
      handleRetryUpload(item);
    }
  };

  /**
   * Renders each individual submission item with explicit feedback cues.
   */
  const renderSubmissionItem = ({ item }: { item: SubmissionRecord }) => {
    const badge = getStatusBadgeStyle(item.status);
    const isReadyForReview = item.status === 'PENDING_REVIEW';
    const isReviewed = item.status === 'REVIEWED';
    const isUploadPending = item.status === 'UPLOAD_PENDING';
    const isThisCardRetrying = retryingId === item.id;

    return (
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={() => handleCardPress(item)}
        style={[
          styles.submissionCard,
          {
            backgroundColor: colors.surface,
            borderColor: colors.border,
          },
        ]}
      >
        <View style={styles.cardHeaderRow}>
          <Text style={[styles.referenceText, { color: colors.textPrimary }]} numberOfLines={1}>
            {item.reference || 'Homestay Guest Capture'}
          </Text>
          <View style={[styles.statusBadge, { backgroundColor: badge.backgroundColor }]}>
            <Text style={styles.statusBadgeText}>{badge.label}</Text>
          </View>
        </View>

        <View style={styles.cardMetaRow}>
          <Text style={[styles.metaLabel, { color: colors.textMuted }]}>
            ID: <Text style={{ color: colors.textPrimary }}>{item.id.slice(0, 16)}...</Text>
          </Text>
          <Text style={[styles.metaLabel, { color: colors.textMuted }]}>
            {item.guest_count} Guest{item.guest_count > 1 ? 's' : ''}
          </Text>
        </View>

        <View style={styles.cardFooterRow}>
          <Text style={[styles.dateText, { color: colors.textMuted }]}>
            {formatDate(item.created_at)}
          </Text>

          {isThisCardRetrying ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : isUploadPending ? (
            <Text style={[styles.actionPromptText, { color: colors.accent }]}>
              Tap to Retry Upload ⟳
            </Text>
          ) : isReadyForReview ? (
            <Text style={[styles.actionPromptText, { color: colors.statusReady }]}>
              Tap to Verify →
            </Text>
          ) : isReviewed ? (
            <Text style={[styles.actionPromptText, { color: colors.statusDone }]}>
              Open Form-C Portal ↗
            </Text>
          ) : (
            <Text style={[styles.actionPromptText, { color: colors.textMuted }]}>
              {item.status}
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Top Navigation & App Bar */}
      <View style={[styles.topBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <Text style={[styles.appTitle, { color: colors.primaryBrand }]}>Homestay Document Capture</Text>
        <TouchableOpacity
          onPress={toggleTheme}
          style={[styles.themeToggleButton, { backgroundColor: colors.surfaceSubtle }]}
        >
          <Text style={styles.themeToggleIcon}>{isDark ? '☀️' : '🌙'}</Text>
        </TouchableOpacity>
      </View>

      {/* Main Queue List */}
      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={colors.primaryBrand} />
        </View>
      ) : (
        <FlatList
          data={submissions}
          keyExtractor={(item) => item.id}
          renderItem={renderSubmissionItem}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              colors={[colors.primaryBrand]}
              tintColor={colors.primaryBrand}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No captures yet</Text>
              <Text style={[styles.emptySubtitle, { color: colors.textMuted }]}>
                Tap the button below to capture the guest documents.
              </Text>
            </View>
          }
        />
      )}

      {/* Floating Bottom Sticky Action Bar */}
      <View style={[styles.bottomBarContainer, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
        <TouchableOpacity
          onPress={onStartNewCapture}
          style={[styles.primaryActionButton, { backgroundColor: colors.primaryBrand }]}
        >
          <Text style={styles.primaryActionText}>+ New Guest Capture</Text>
        </TouchableOpacity>
      </View>
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
  topBar: {
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  appTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  themeToggleButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  themeToggleIcon: {
    fontSize: 18,
  },
  listContent: {
    padding: 16,
    paddingBottom: 90,
  },
  submissionCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  referenceText: {
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
    marginRight: 8,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  statusBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  cardMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  metaLabel: {
    fontSize: 13,
  },
  cardFooterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E2E8F0',
    paddingTop: 8,
  },
  dateText: {
    fontSize: 12,
  },
  actionPromptText: {
    fontSize: 13,
    fontWeight: '600',
  },
  emptyContainer: {
    paddingTop: 60,
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  bottomBarContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    borderTopWidth: 1,
  },
  primaryActionButton: {
    height: 50,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryActionText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});