package api

import (
	"encoding/base64"
	"strings"
)

// splitJWT splits a JWT (header.payload.signature) into its dotted
// parts. Defined here (not in the openai refresh file) so it can be
// reused by any future api-level helper that needs to peek at a JWT's
// payload without bringing in a JWT library.
func splitJWT(token string) []string {
	return strings.Split(token, ".")
}

// base64URLDecode handles both the raw (no padding) and padded variants
// of base64url. JWT spec mandates raw, but some IDPs emit padded blobs
// and tolerating both costs nothing.
func base64URLDecode(s string) ([]byte, error) {
	if b, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.URLEncoding.DecodeString(s)
}
