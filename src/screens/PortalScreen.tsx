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
          console.log('[PortalScreen] Loaded verified guest fields from SQLite:', parsed);
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
   * Does NOT auto-submit; operator enters CAPTCHA and clicks Sign In manually.
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

      // JavaScript injection script safely escaping quotes
      const sanitizedUser = JSON.stringify(creds.userId);
      const sanitizedPass = JSON.stringify(creds.password);

      const loginInjectionJs = `
        (function() {
          try {
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
   * Action: Injects verified guest values into the Form-C arrival registration form.
   * Queries standard Form-C field selectors, handles dropdown matching, and dispatches events.
   */
  const handleAutofillGuestData = () => {
    if (!guestData) {
      Alert.alert('Notice', 'No verified guest data found for this submission.');
      return;
    }

    // Prepare stringified payload for safe injection
    const payloadJson = JSON.stringify(guestData);

    const formCAutoFillJs = `
      (function() {
        try {
          var data = ${payloadJson};
          var fieldsUpdated = 0;

          // Helper to set value and dispatch synthetic events
          function setField(selectors, val) {
            if (!val) return;
            for (var i = 0; i < selectors.length; i++) {
              var el = document.querySelector(selectors[i]);
              if (el) {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                fieldsUpdated++;
                break;
              }
            }
          }

          // Helper for dropdown select elements
          function setSelect(selectors, targetText) {
            if (!targetText) return;
            for (var i = 0; i < selectors.length; i++) {
              var sel = document.querySelector(selectors[i]);
              if (sel && sel.options) {
                var targetLower = String(targetText).toLowerCase().trim();
                for (var j = 0; j < sel.options.length; j++) {
                  var optText = sel.options[j].text.toLowerCase();
                  var optVal = sel.options[j].value.toLowerCase();
                  if (optText.includes(targetLower) || optVal === targetLower) {
                    sel.selectedIndex = j;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    fieldsUpdated++;
                    return;
                  }
                }
              }
            }
          }

          // 1. Foreigner Name fields (Surname First / Given Name)
          setField(['input[name="sur_name"]', '#sur_name', 'input[name="surname"]'], data.surname);
          setField(['input[name="given_name"]', '#given_name', 'input[name="first_name"]'], data.givenName);

          // 2. Passport & Identity
          setField(['input[name="pass_num"]', '#pass_num', 'input[name="passport_no"]'], data.passportNumber);
          setSelect(['select[name="nationality"]', '#nationality', 'select[name="spl_category"]'], data.nationality);
          setField(['input[name="dob"]', '#dob', 'input[name="date_of_birth"]'], data.dateOfBirth);

          // 3. Visa / OCI Details
          setField(['input[name="visa_num"]', '#visa_num', 'input[name="visa_number"]'], data.visaNumber);

          // 4. Arrival & Departure details
          setField(['input[name="arri_from"]', '#arri_from', 'input[name="arrived_from"]'], data.arrivedFrom);
          setField(['input[name="proc_to"]', '#proc_to', 'input[name="proceeding_to"]'], data.proceedingTo);
          setField(['input[name="purpose_of_visit"]', '#purpose_of_visit', 'input[name="purpose"]'], data.purposeOfVisit || 'Tourism');

          // Return count back to React Native via console or alert
          console.log('[FormC Autofill] Updated ' + fieldsUpdated + ' fields successfully.');
          alert('Auto-filled ' + fieldsUpdated + ' guest fields! Please review before submission.');
        } catch (err) {
          console.error('[FormC Autofill] Error injecting fields:', err);
          alert('Error during field population: ' + err.message);
        }
      })();
      true;
    `;

    webViewRef.current?.injectJavaScript(formCAutoFillJs);
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

      {/* Embedded In-App WebView */}
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

      {/* Floating Bottom In-App Control Bar */}
      <View
        style={[
          styles.bottomBar,
          { backgroundColor: colors.surface, borderTopColor: colors.border },
        ]}
      >
        {/* Assisted Login Button */}
        <TouchableOpacity
          onPress={handleAutofillLogin}
          style={[styles.actionButton, { backgroundColor: colors.accent }]}
        >
          <Text style={styles.actionButtonText}>🔑 Autofill Login</Text>
        </TouchableOpacity>

        {/* Populate Guest Data Button */}
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