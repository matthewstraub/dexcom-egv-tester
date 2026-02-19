# Project TODO

- [x] Add Dexcom API secrets (client_id, client_secret)
- [x] Create Dexcom OAuth2 backend routes (authorize, callback, token exchange)
- [x] Create Dexcom API proxy routes (EGV data, data range)
- [x] Store Dexcom tokens in database (access_token, refresh_token per user)
- [x] Build dark theme developer console UI
- [x] Build OAuth flow page with step-by-step visualizer
- [x] Build EGV data display with chart and data table
- [x] Build raw JSON response viewer with syntax highlighting
- [x] Add date range picker for EGV queries
- [x] Write vitest tests for backend routes
- [x] Fix 'Invalid Date Range Error' when querying EGV data
- [x] Add production Dexcom API base URL support (api.dexcom.com)
- [x] Add environment toggle (Sandbox vs Production) to backend
- [x] Store environment preference per user in database
- [x] Update OAuth flow to use correct base URL per environment
- [x] Add environment toggle UI in the frontend
- [x] Update tests for dual-environment support
