import React, { useRef, useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
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
  const [currentUrl, setCurrentUrl] = useState<string>(
    'https://indianfrro.gov.in/frro/FormC/login.jsp'
  );
  const [guestData, setGuestData] = useState<any>(null);

  /**
   * Loads verified guest Form-C data from the local SQLite database on mount.
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
   * Handles diagnostic feedback messages returned from the WebView JavaScript context.
   */
  const handleWebViewMessage = (event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'AUTOFILL_LOGIN_RESULT') {
        if (data.success) {
          Alert.alert('Autofill Succeeded', data.message);
        } else {
          Alert.alert(
            'Autofill Notice',
            `${data.message}\n\nDetected Inputs on Page:\n${data.foundInputs || 'None'}`
          );
        }
      } else if (data.type === 'AUTOFILL_FORM_RESULT') {
        Alert.alert(data.success ? 'Form Autofill' : 'Notice', data.message);
      }
    } catch {
      console.log('[PortalScreen] Raw WebView message:', event.nativeEvent.data);
    }
  };

  /**
   * Action: Injects stored portal credentials into login DOM inputs.
   * Traverses main document, sub-frames, and iframes using prototype value setters.
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

      const sanitizedUser = JSON.stringify(creds.userId);
      const sanitizedPass = JSON.stringify(creds.password);

      const loginInjectionJs = `
        (function() {
          try {
            var targetUserVal = ${sanitizedUser};
            var targetPassVal = ${sanitizedPass};

            // Prototype setter helper to bypass portal event trapping
            function applyInputValue(inputEl, value) {
              if (!inputEl) return;
              inputEl.focus();
              var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
              if (nativeSetter && nativeSetter.set) {
                nativeSetter.set.call(inputEl, value);
              } else {
                inputEl.value = value;
              }
              inputEl.dispatchEvent(new Event('input', { bubbles: true }));
              inputEl.dispatchEvent(new Event('change', { bubbles: true }));
              inputEl.dispatchEvent(new Event('blur', { bubbles: true }));
            }

            // Search both main document and accessible frames
            var searchContexts = [document];
            var iframes = document.querySelectorAll('iframe, frame');
            for (var i = 0; i < iframes.length; i++) {
              try {
                if (iframes[i].contentDocument) {
                  searchContexts.push(iframes[i].contentDocument);
                }
              } catch(e) {}
            }

            var userInput = null;
            var passInput = null;
            var recordedInputs = [];

            for (var c = 0; c < searchContexts.length; c++) {
              var ctx = searchContexts[c];

              // Direct attribute selectors
              if (!userInput) {
                userInput = ctx.querySelector('input[name="u_id"]') ||
                            ctx.querySelector('#u_id') ||
                            ctx.querySelector('input[name*="user" i]') ||
                            ctx.querySelector('input[name*="uid" i]') ||
                            ctx.querySelector('input[name*="login" i]');
              }

              if (!passInput) {
                passInput = ctx.querySelector('input[name="u_pwd"]') ||
                            ctx.querySelector('#u_pwd') ||
                            ctx.querySelector('input[type="password"]');
              }

              var allInputs = ctx.querySelectorAll('input');
              for (var k = 0; k < allInputs.length; k++) {
                var inp = allInputs[k];
                recordedInputs.push(inp.name ? ('name=' + inp.name) : (inp.id ? ('id=' + inp.id) : ('type=' + inp.type)));
              }

              // Fallback: previous input before password
              if (passInput && !userInput) {
                var allCtxInputs = Array.from(ctx.querySelectorAll('input'));
                var passIdx = allCtxInputs.indexOf(passInput);
                for (var j = passIdx - 1; j >= 0; j--) {
                  var candidate = allCtxInputs[j];
                  if (candidate.type === 'text' || candidate.type === '') {
                    userInput = candidate;
                    break;
                  }
                }
              }

              if (userInput && passInput) break;
            }

            if (userInput && passInput) {
              applyInputValue(userInput, targetUserVal);
              applyInputValue(passInput, targetPassVal);

              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'AUTOFILL_LOGIN_RESULT',
                success: true,
                message: 'Credentials filled successfully! Please enter CAPTCHA and sign in.'
              }));
            } else {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'AUTOFILL_LOGIN_RESULT',
                success: false,
                message: 'Could not find Username or Password input elements.',
                foundInputs: recordedInputs.join(', ')
              }));
            }
          } catch (err) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'AUTOFILL_LOGIN_RESULT',
              success: false,
              message: 'Script error: ' + err.message
            }));
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
   * Action: Injects verified guest values into the Form-C arrival registration form DOM.
   * Maps surname, given name, passport details, visa details, and travel origins/destinations.
   */
  const handleAutofillGuestData = () => {
    if (!guestData) {
      Alert.alert('Notice', 'No verified guest data found for this submission.');
      return;
    }

    const payloadJson = JSON.stringify(guestData);

    const formCAutoFillJs = `
      (function() {
        try {
          var data = ${payloadJson};
          var fieldsUpdated = 0;

          // Helper to populate standard text inputs using prototype setter
          function setField(selectors, val) {
            if (!val) return;
            for (var i = 0; i < selectors.length; i++) {
              var el = document.querySelector(selectors[i]);
              if (el) {
                el.focus();
                var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
                if (nativeSetter && nativeSetter.set) {
                  nativeSetter.set.call(el, val);
                } else {
                  el.value = val;
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
                fieldsUpdated++;
                break;
              }
            }
          }

          // Helper to select matching option in standard dropdowns
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

          // Helper to resolve field value supporting both camelCase and snake_case keys
          function getVal(keyCamel, keySnake) {
            var val = data[keyCamel] || data[keySnake];
            if (val && typeof val === 'object' && 'value' in val) {
              return val.value;
            }
            return val || '';
          }

          // 1. Foreigner Name fields (Surname First / Given Names)
          setField(['input[name="sur_name"]', '#sur_name', 'input[name="surname"]'], getVal('surname', 'surname'));
          setField(['input[name="given_name"]', '#given_name', 'input[name="first_name"]'], getVal('givenName', 'given_names') || getVal('givenName', 'given_name'));

          // 2. Passport & Identity
          setField(['input[name="pass_num"]', '#pass_num', 'input[name="passport_no"]'], getVal('passportNumber', 'passport_number'));
          setSelect(['select[name="nationality"]', '#nationality', 'select[name="spl_category"]'], getVal('nationality', 'nationality'));
          setField(['input[name="dob"]', '#dob', 'input[name="date_of_birth"]'], getVal('dateOfBirth', 'date_of_birth'));

          // 3. Visa / OCI Details
          setField(['input[name="visa_num"]', '#visa_num', 'input[name="visa_number"]'], getVal('visaNumber', 'visa_number'));

          // 4. Arrival & Departure Details (Form-C Rule 14)
          setField(['input[name="arri_from"]', '#arri_from', 'input[name="arrived_from"]'], getVal('arrivedFrom', 'arrived_from'));
          setField(['input[name="proc_to"]', '#proc_to', 'input[name="proceeding_to"]'], getVal('proceedingTo', 'proceeding_to'));
          setField(['input[name="purpose_of_visit"]', '#purpose_of_visit', 'input[name="purpose"]'], getVal('purposeOfVisit', 'purpose_of_visit') || 'Tourism');

          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'AUTOFILL_FORM_RESULT',
            success: true,
            message: 'Auto-filled ' + fieldsUpdated + ' guest fields! Please review before submission.'
          }));
        } catch (err) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'AUTOFILL_FORM_RESULT',
            success: false,
            message: 'Error during field population: ' + err.message
          }));
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
          onMessage={handleWebViewMessage}
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