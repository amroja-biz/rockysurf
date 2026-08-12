# End-to-End Test Checklist

Manual test checklist for verifying the full Rocky Surf flow on a fresh deployment.

## Prerequisites
- Fresh deployment of all stacks (secrets, dynamodb, api-gateway, websocket, lambdas, eventbridge, cloudfront)
- Frontend deployed and accessible
- GitHub OAuth App configured with correct callback URL
- GitHub App installed on at least one repo

---

## Test Cases

### 1. GitHub OAuth Login
- [ ] Navigate to the app URL
- [ ] Click "Sign in with GitHub"
- [ ] Authorize the OAuth app on GitHub
- [ ] Verify redirect back to the app with user logged in
- [ ] Verify avatar and username display in header

### 2. Auth Persistence
- [ ] Refresh the page
- [ ] Verify user remains logged in (token persisted in localStorage)
- [ ] Verify WebSocket connection status shows "connected"

### 3. GitHub App Installation Prompt
- [ ] If GitHub App not installed, verify installation prompt appears on create server page
- [ ] Click install link, complete installation on GitHub
- [ ] Return to app and verify repos are now available

### 4. Create On-Demand Server
- [ ] Click "Create Server"
- [ ] Enter a server name
- [ ] Select "Small" size
- [ ] Select "On-Demand" pricing
- [ ] Select "Claude Code" tool
- [ ] Select at least one repository
- [ ] Click "Create Server"
- [ ] Verify redirect to dashboard

### 5. Provisioning Status & Progress
- [ ] Verify new server appears in dashboard with "Provisioning" status
- [ ] Verify spinning indicator next to "Provisioning" badge on dashboard
- [ ] Click into server detail page
- [ ] Verify provisioning timeline shows with 3 steps
- [ ] Verify first step shows completed (checkmark)
- [ ] Verify subsequent steps show spinner (in-progress)
- [ ] Verify estimated time text displays "~10-20 minutes"

### 6. WebSocket Real-Time Updates
- [ ] Wait for provisioning to complete (10-20 min)
- [ ] Verify status changes to "Running" without page refresh
- [ ] Verify dashboard card updates in real-time
- [ ] Verify server detail page updates in real-time

### 7. Server Detail with Connection Info
- [ ] Verify Elastic IP is displayed
- [ ] Verify SSH command is displayed (ssh rocky@<ip>)
- [ ] Verify copy buttons work for IP and SSH command
- [ ] Verify instance details (size, type, pricing, created date, uptime)
- [ ] Verify tools section shows selected tools
- [ ] Verify repositories section shows selected repos with links

### 8. SSH Key Download
- [ ] Verify SSH key was provided during creation (if applicable)
- [ ] Verify SSH connection works: `ssh -i <key> rocky@<elastic-ip>`

### 9. Stop Server
- [ ] Click "Stop Server" button
- [ ] Verify confirmation modal appears
- [ ] Confirm stop action
- [ ] Verify status changes to "Stopped"
- [ ] Verify "Start Server" and "Resize" buttons appear

### 10. Resize Server (While Stopped)
- [ ] Click "Resize" button
- [ ] Verify resize modal shows current size highlighted with "(current)"
- [ ] Select a different size (e.g., Medium)
- [ ] Verify confirm button is enabled
- [ ] Click "Resize Server"
- [ ] Verify size updates in instance details
- [ ] Verify instance type updates accordingly

### 11. Start Server
- [ ] Click "Start Server" button
- [ ] Verify status changes to "Running"
- [ ] Verify SSH connection still works with same IP

### 12. Add Repository
- [ ] Call POST /servers/{serverId}/repositories with `{ "repository": "owner/repo" }`
- [ ] Verify 200 response with updated server object
- [ ] Verify new repository appears in server detail page
- [ ] Verify duplicate repository returns 400

### 13. Terminate Server
- [ ] Click "Terminate Server" button
- [ ] Verify confirmation modal appears with destructive warning
- [ ] Confirm terminate action
- [ ] Verify redirect to dashboard
- [ ] Verify server no longer appears in server list

### 14. Create & Terminate Spot Server
- [ ] Create a new server with "Spot" pricing
- [ ] Verify spot warning banner appears on server detail page
- [ ] Verify "Resize" button does NOT appear (spot instances can't resize)
- [ ] Verify "Stop" button does NOT appear (spot instances can't stop)
- [ ] Terminate the spot server
- [ ] Verify cleanup completes

---

## Notes
- If any step fails, document the exact error and behavior
- WebSocket updates may take a few seconds to propagate
- Spot instances may be interrupted by AWS at any time during testing
