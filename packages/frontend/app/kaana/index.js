"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var vector_icons_1 = require("@expo/vector-icons");
var services_1 = require("@oxyhq/services");
var react_1 = require("react");
var react_native_1 = require("react-native");
var KaanaClientPage = function () {
    var user = (0, services_1.useOxy)().user;
    var _a = (0, react_1.useState)(""), inputText = _a[0], setInputText = _a[1];
    var _b = (0, react_1.useState)(40), inputHeight = _b[0], setInputHeight = _b[1];
    var handleTextChange = function (text) {
        setInputText(text);
    };
    var handleContentSizeChange = function (event) {
        var contentHeight = Math.max(40, event.nativeEvent.contentSize.height);
        if (inputHeight !== contentHeight) {
            setInputHeight(contentHeight);
        }
    };
    return (<react_native_1.SafeAreaView style={styles.safeArea}>
      <react_native_1.StatusBar barStyle="light-content"/>
      <react_native_1.View style={styles.container}>
        
        {/* Main Content */}
        <react_native_1.View style={styles.mainContent}>
          <react_native_1.Text style={styles.title}>Hello, {(user === null || user === void 0 ? void 0 : user.username) || "Nate"}.</react_native_1.Text>
          <react_native_1.Text style={styles.subtitle}>How can I help you today?</react_native_1.Text>
          
          {/* Action Buttons */}
          <react_native_1.View style={styles.buttonGrid}>
            <react_native_1.View style={styles.buttonRow}>
              <react_native_1.TouchableOpacity style={styles.actionButton}>
                <vector_icons_1.Ionicons name="image-outline" size={22} color="#fff"/>
                <react_native_1.Text style={styles.buttonText}>Editar imagen</react_native_1.Text>
                <react_native_1.View style={styles.dropdownIndicator}>
                  <vector_icons_1.Ionicons name="chevron-down" size={16} color="#fff"/>
                </react_native_1.View>
              </react_native_1.TouchableOpacity>
              <react_native_1.TouchableOpacity style={styles.actionButton}>
                <vector_icons_1.Ionicons name="newspaper-outline" size={22} color="#fff"/>
                <react_native_1.Text style={styles.buttonText}>Noticias más recientes</react_native_1.Text>
              </react_native_1.TouchableOpacity>
            </react_native_1.View>
            <react_native_1.View style={styles.buttonRow}>
              <react_native_1.TouchableOpacity style={styles.actionButton}>
                <vector_icons_1.Ionicons name="person-outline" size={22} color="#fff"/>
                <react_native_1.Text style={styles.buttonText}>Personalidades</react_native_1.Text>
                <react_native_1.View style={styles.dropdownIndicator}>
                  <vector_icons_1.Ionicons name="chevron-down" size={16} color="#fff"/>
                </react_native_1.View>
              </react_native_1.TouchableOpacity>
              <react_native_1.TouchableOpacity style={styles.actionButton}>
                <vector_icons_1.Ionicons name="briefcase-outline" size={22} color="#fff"/>
                <react_native_1.Text style={styles.buttonText}>Áreas de trabajo</react_native_1.Text>
                <react_native_1.View style={styles.dropdownIndicator}>
                  <vector_icons_1.Ionicons name="chevron-down" size={16} color="#fff"/>
                </react_native_1.View>
              </react_native_1.TouchableOpacity>
            </react_native_1.View>
          </react_native_1.View>
        </react_native_1.View>
        
        {/* Input Area at Bottom */}
        <react_native_1.KeyboardAvoidingView behavior={react_native_1.Platform.OS === "ios" ? "padding" : undefined} style={styles.inputContainer}>
          <react_native_1.View style={styles.inputBar}>
            <react_native_1.TouchableOpacity style={styles.inputIcon}>
              <vector_icons_1.Ionicons name="attach-outline" size={22} color="#aaa"/>
            </react_native_1.TouchableOpacity>
            <react_native_1.TouchableOpacity style={styles.inputIcon}>
              <vector_icons_1.Ionicons name="refresh-outline" size={22} color="#aaa"/>
            </react_native_1.TouchableOpacity>
            <react_native_1.TouchableOpacity style={styles.inputIcon}>
              <vector_icons_1.Ionicons name="bulb-outline" size={22} color="#aaa"/>
            </react_native_1.TouchableOpacity>
            
            <react_native_1.TextInput style={[styles.input, { height: inputHeight }]} placeholder="¿Qué quieres saber?" placeholderTextColor="#aaa" multiline value={inputText} onChangeText={handleTextChange} onContentSizeChange={handleContentSizeChange}/>
            
            <react_native_1.View style={styles.inputRightButtons}>
              <react_native_1.TouchableOpacity style={styles.modelSelector}>
                <react_native_1.Text style={styles.modelText}>Kaana o1</react_native_1.Text>
                <vector_icons_1.Ionicons name="chevron-down" size={16} color="#fff"/>
              </react_native_1.TouchableOpacity>
              <react_native_1.TouchableOpacity style={styles.sendButton}>
                <vector_icons_1.Ionicons name="arrow-up" size={22} color="#fff"/>
              </react_native_1.TouchableOpacity>
            </react_native_1.View>
          </react_native_1.View>
        </react_native_1.KeyboardAvoidingView>
      </react_native_1.View>
    </react_native_1.SafeAreaView>);
};
var styles = react_native_1.StyleSheet.create({
    safeArea: {
        flex: 1,
        backgroundColor: '#1a1a1a',
        borderRadius: 35,
    },
    container: {
        flex: 1,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    logoContainer: {
        width: 40,
        height: 40,
        justifyContent: 'center',
        alignItems: 'center',
    },
    logo: {
        width: 24,
        height: 24,
    },
    headerRight: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    iconButton: {
        marginLeft: 20,
    },
    avatarContainer: {
        marginLeft: 20,
        width: 36,
        height: 36,
        borderRadius: 18,
        overflow: 'hidden',
    },
    avatar: {
        width: 36,
        height: 36,
    },
    mainContent: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 20,
    },
    title: {
        fontSize: 32,
        fontWeight: '600',
        color: '#fff',
        textAlign: 'center',
        marginBottom: 8,
    },
    subtitle: {
        fontSize: 24,
        fontWeight: '400',
        color: '#a0a0a0',
        textAlign: 'center',
        marginBottom: 40,
    },
    buttonGrid: {
        width: '100%',
        maxWidth: 500,
    },
    buttonRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 16,
    },
    actionButton: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(60, 60, 60, 0.5)',
        borderRadius: 30,
        padding: 16,
        marginHorizontal: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.2,
        shadowRadius: 4,
        elevation: 3,
        position: 'relative',
    },
    buttonText: {
        color: '#fff',
        fontSize: 15,
        fontWeight: '500',
        marginLeft: 8,
        flex: 1,
    },
    dropdownIndicator: {
        marginLeft: 4,
    },
    inputContainer: {
        width: '100%',
        padding: 16,
        backgroundColor: 'transparent',
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
    },
    inputBar: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(40, 40, 40, 0.7)',
        borderRadius: 30,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    inputIcon: {
        marginHorizontal: 8,
    },
    input: {
        flex: 1,
        fontSize: 16,
        color: '#fff',
        paddingHorizontal: 8,
        minHeight: 40,
        maxHeight: 120,
    },
    inputRightButtons: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    modelSelector: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(60, 60, 60, 0.5)',
        borderRadius: 20,
        paddingVertical: 6,
        paddingHorizontal: 12,
        marginRight: 8,
    },
    modelText: {
        color: '#fff',
        fontSize: 14,
        marginRight: 4,
    },
    sendButton: {
        backgroundColor: 'rgba(60, 60, 60, 0.8)',
        width: 40,
        height: 40,
        borderRadius: 20,
        justifyContent: 'center',
        alignItems: 'center',
    },
});
exports.default = KaanaClientPage;
