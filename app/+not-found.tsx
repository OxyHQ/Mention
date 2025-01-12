import { Link } from "expo-router";
import { StyleSheet, Text, View } from 'react-native';
import { colors } from "@/styles/colors";

export default function NotFound() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>This page isn’t available</Text>
      <Text style={styles.description}>
        Sorry, we couldn’t find the page you were looking for. You can return to the Explore page or try searching for something else.
      </Text>

      <Link href="/explore">
        <View style={styles.buttonContainer}>
          <Text style={styles.buttonText}>Go to Explore</Text>
        </View>
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0f1419',
    marginBottom: 16,
    textAlign: 'center',
  },
  description: {
    fontSize: 16,
    fontWeight: '400',
    color: '#536471',
    marginBottom: 32,
    textAlign: 'center',
    lineHeight: 24,
  },
  buttonContainer: {
    backgroundColor: colors.primaryColor,
    borderRadius: 9999,
    paddingVertical: 12,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    color: colors.primaryLight,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  buttonHover: {
    backgroundColor: colors.primaryColor,
  },
  buttonActive: {
    backgroundColor: colors.primaryColor,
  },
  buttonFocusVisible: {
    borderColor: colors.primaryColor,
    borderWidth: 2,
  },
});
