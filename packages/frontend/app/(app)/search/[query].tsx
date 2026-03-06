import { useEffect } from "react";
import { router, useLocalSearchParams } from "expo-router";

// This route handles direct URLs like /search/cats
// It redirects to the main search page with the query pre-filled
export default function SearchWithQuery() {
    const params = useLocalSearchParams();
    const query = (params.query as string) || "";

    useEffect(() => {
        // Navigate to main search page with query param
        router.replace({
            pathname: "/search",
            params: { q: query.trim() }
        });
    }, [query]);

    return null;
}
