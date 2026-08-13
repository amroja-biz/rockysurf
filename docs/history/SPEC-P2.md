# Rocky Surf - Phase 2 Specification

This document outlines features planned for Phase 2, after the Phase 1 dogfooding period validates the core product.

**Prerequisite:** Phase 1 complete and stable (see SPEC-P1.md)

---

## Table of Contents

1. [Billing System](#billing-system)
2. [Budget Tier (Reseller Option)](#budget-tier-reseller-option)
3. [Multi-Region Support](#multi-region-support)
4. [Team Features](#team-features)
5. [Enhanced Monitoring](#enhanced-monitoring)
6. [Egress Proxy](#egress-proxy)
7. [Notifications](#notifications)

---

## Billing System

**Model:** Cost-plus with monthly upfront payment

- Users pay monthly in advance
- Pricing = AWS cost + margin
- Margin TBD based on market research

**Potential pricing (example with 50% margin):**

| Size | Estimated Price |
|------|----------------|
| Small | $50/month |
| Medium | $99/month |
| Large | $200/month |

**Alternative consideration:** Hourly billing based on actual usage

**Implementation:**
- Stripe integration
- Usage metering
- Invoice generation
- Payment collection

---

## Budget Tier (Reseller Option)

For price-sensitive customers, offer a budget tier using white-label VPS resellers instead of AWS.

**Approach:**
- Integration with white-label VPS reseller (CloudCone, Rad Web Hosting, etc.)
- AWS for premium tier, reseller for budget tier
- Same dashboard experience, different underlying infrastructure

**Tradeoffs:**
- Lower cost for customers
- Less control over infrastructure
- Potentially different reliability/performance characteristics

---

## Multi-Region Support

Expand beyond us-east-1 based on user demand.

**Planned regions:**
- us-west-2 (Oregon)
- eu-west-1 (Ireland)
- ap-northeast-1 (Tokyo)

**Implementation considerations:**
- CloudFormation templates work across regions
- DynamoDB global tables or per-region tables
- Region selection in server creation flow

---

## Team Features

Support multiple users per organization.

**Features:**
- Multiple users per account
- Shared servers (view/manage servers created by teammates)
- Role-based access control (admin, member, viewer)
- Organization billing (single invoice for all team usage)

**Data model changes:**
- Organizations table
- User-to-organization membership
- Server ownership (user vs organization)

---

## Enhanced Monitoring

Provide visibility into server and agent activity.

**Features:**
- Server health metrics (CPU, memory, disk)
- Agent activity logs (stdout/stderr capture)
- Usage analytics (hours used, cost trends)
- Dashboard charts and graphs

**Implementation:**
- CloudWatch metrics collection
- Log aggregation service
- Analytics dashboard in frontend

---

## Egress Proxy

Add network-level visibility and control for outbound traffic.

**Features:**
- HTTP/HTTPS proxy with logging
- URL allowlisting (optional, per-server)
- Abuse detection (unusual traffic patterns)
- Network activity dashboard

**Use cases:**
- Debugging what agents are accessing
- Security compliance requirements
- Preventing accidental data exfiltration

**Implementation:**
- Squid or similar proxy in VPC
- Route server traffic through proxy
- Log storage and analysis

---

## Notifications

Keep users informed about server events.

**Channels:**
- Email notifications
- Browser push notifications

**Events:**
- Server is ready (provisioning complete)
- Spot instance interruption warning
- Server stopped/terminated
- Billing alerts (approaching limits)

**Implementation:**
- AWS SES for email
- Web Push API for browser notifications
- Notification preferences in settings page

---

## Open Questions (Phase 2)

1. **Pricing:** Exact margin for cost-plus pricing model
2. **Reseller:** Which VPS reseller to partner with for budget tier
3. **Teams:** Pricing model for team accounts (per-seat vs per-server)
4. **Regions:** Priority order for adding regions based on user requests

---

*Last updated: 2026-02-01*
