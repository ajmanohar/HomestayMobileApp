import React, { useRef, useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useAppTheme } from '../theme/ThemeContext';
import { openDatabase, GuestDocumentRecord } from '../db/database';
import { getPortalCredentials } from '../services/credentialService';

interface PortalScreenProps {
  submissionId: string;
  onClose: () => void;
}

export const PortalScreen: React.FC<PortalScreenProps> = ({ submissionId, onClose }) => {
  const { colors } = useAppTheme();
  const webViewRef = useRef<WebView>(null);

  // Screen state
  const [loadingWeb, setLoadingWeb] = useState<boolean>(true);
  const [currentUrl, setCurrentUrl] = useState<string>('https://indianfrro.gov.in/frro/FormC/login.jsp');
  const [guestData, setGuestData] = useState<any>(null);

  /**
   * Loads verified guest Form-C data from local SQLite database on mount.
   */
  useEffect(() => {
    const fetchGuestRecord = async () => {
      try {
        const db = await openDatabase();
        const docs = await db.getAllAsync<GuestDocumentRecord>(
          `SELECT * FROM guest_documents WHERE submission_id = ? ORDER BY guest_index ASC LIMIT 1;`,
          [submissionId]
        );

        if (docs.length > 0 && docs[0].extracted_data_json) {
          const parsed = JSON.parse(docs[0].extracted_data_json);
          setGuestData(parsed);
        }
      } catch (error) {
        console.warn('[PortalScreen] Failed to load guest data from SQLite:', error);
      }
    };

    fetchGuestRecord();
  }, [submissionId]);

  /**
   * Action: Injects stored portal credentials into login DOM inputs.
   * Matches <input name="u_id"> and <input name="u_pwd">.
   * Does NOT auto-submit; operator enters CAPTCHA and clicks Sign In manually[cite: 1].
   */
  const handleAutofillLogin = async () => {
    try {
      const creds = await getPortalCredentials();

      if (!creds.userId || !creds.password) {
        Alert.alert(
          'Missing Credentials',
          'Please configure your Portal User ID and Password using the Key (🔑) icon on the Dashboard first.'
        );
        return;
      }

      // JavaScript injection script safely escaping quotes[cite: 1]
      const sanitizedUser = JSON.stringify(creds.userId);
      const sanitizedPass = JSON.stringify(creds.password);

      const loginInjectionJs = `
        (function() {
          try {
            // Locate user ID and password elements on the official Form-C login page[cite: 1]
            var userInput = document.querySelector('input[name="u_id"]') || document.querySelector('#u_id');
            var passInput = document.querySelector('input[name="u_pwd"]') || document.querySelector('#u_pwd');

            if (userInput) {
              userInput.value = ${sanitizedUser};
              userInput.dispatchEvent(new Event('input', { bubbles: true }));
              userInput.dispatchEvent(new Event('change', { bubbles: true }));
            }

            if (passInput) {
              passInput.value = ${sanitizedPass};
              passInput.dispatchEvent(new Event('input', { bubbles: true }));
              passInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } catch (e) {
            console.error('Portal login injection error:', e);
          }
        })();
        true;
      `;

      webViewRef.current?.injectJavaScript(loginInjectionJs);
    } catch (error: any) {
      Alert.alert('Autofill Error', error.message || 'Could not inject login credentials.');
    }
  };

  /**
   * Action placeholder: Injects verified guest values into Form-C fields (Step 5)[cite: 1].
   */
  const handleAutofillGuestData = () => {
    if (!guestData) {
      Alert.alert('Notice', 'No verified guest data found for this submission.');
      return;
    }

    Alert.alert(
      'Ready for Step 5',
      `Guest data for ${guestData.givenName || guestData.given_name || 'Guest'} will be populated into the Form-C fields.`
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Top App Header */}
      <View
        style={[
          styles.headerBar,
          { backgroundColor: colors.surface, borderBottomColor: colors.border },
        ]}
      >
        <TouchableOpacity onPress={onClose} style={styles.closeButton}>
          <Text style={[styles.closeButtonText, { color: colors.textPrimary }]}>✕ Close</Text>
        </TouchableOpacity>
        <View style={styles.headerTitleContainer}>
          <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>Form-C Portal</Text>
          <Text style={[styles.headerSubtitle, { color: colors.textMuted }]} numberOfLines={1}>
            {currentUrl}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => webViewRef.current?.reload()}
          style={styles.refreshButton}
        >
          <Text style={[styles.refreshButtonText, { color: colors.primaryBrand }]}>⟳</Text>
        </TouchableOpacity>
      </View>

      {/* Embedded In-App WebView[cite: 1] */}
      <View style={styles.webContainer}>
        <WebView
          ref={webViewRef}
          source={{ uri: 'https://indianfrro.gov.in/frro/FormC/login.jsp' }}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          sharedCookiesEnabled={true}
          thirdPartyCookiesEnabled={true}
          onLoadStart={() => setLoadingWeb(true)}
          onLoadEnd={() => setLoadingWeb(false)}
          onNavigationStateChange={(navState) => {
            setCurrentUrl(navState.url);
          }}
          style={styles.webView}
        />

        {loadingWeb && (
          <View style={styles.webLoader}>
            <ActivityIndicator size="large" color={colors.primaryBrand} />
          </View>
        )}
      </View>

      {/* Floating Bottom In-App Control Bar[cite: 1] */}
      <View
        style={[
          styles.bottomBar,
          { backgroundColor: colors.surface, borderTopColor: colors.border },
        ]}
      >
        {/* Autofill Login Action Button[cite: 1] */}
        <TouchableOpacity
          onPress={handleAutofillLogin}
          style={[styles.actionButton, { backgroundColor: colors.accent }]}
        >
          <Text style={styles.actionButtonText}>🔑 Autofill Login</Text>
        </TouchableOpacity>

        {/* Populate Guest Data Action Button[cite: 1] */}
        <TouchableOpacity
          onPress={handleAutofillGuestData}
          style={[styles.actionButton, { backgroundColor: colors.primaryBrand }]}
        >
          <Text style={styles.actionButtonText}>📝 Fill Guest Data</Text>
        </TouchableOpacity>
      </View>
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
  closeButton: {
    padding: 6,
  },
  closeButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  headerTitleContainer: {
    flex: 1,
    alignItems: 'center',
    marginHorizontal: 8,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  headerSubtitle: {
    fontSize: 11,
  },
  refreshButton: {
    padding: 6,
  },
  refreshButtonText: {
    fontSize: 20,
    fontWeight: '700',
  },
  webContainer: {
    flex: 1,
    position: 'relative',
  },
  webView: {
    flex: 1,
  },
  webLoader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
  },
  bottomBar: {
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 16,
    borderTopWidth: 1,
  },
  actionButton: {
    flex: 0.48,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
});