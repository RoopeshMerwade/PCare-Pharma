# MODULE 02 — USER MANAGEMENT
## P.Care Pharma Management System v1.0
---

## 1. FUNCTIONAL DESIGN

### Business Rules
- Only OWNER can create, edit, activate, deactivate staff accounts
- No self-registration — all accounts are owner-created
- Maximum 4 active staff accounts (business constraint)
- Owner account cannot be deactivated from within the app
- Staff can only view and update their OWN profile (name, phone, avatar)
- Staff cannot change their own role or email
- Deactivated staff: session terminated immediately (per-request check already in authenticate middleware)
- Password reset: owner sends a reset email; staff cannot reset others' passwords
- All user management actions written to audit_logs

### Permissions Matrix
| Action                  | Owner | Staff |
|-------------------------|-------|-------|
| List all users          | ✅    | ❌    |
| Create user             | ✅    | ❌    |
| View any user profile   | ✅    | ❌    |
| View own profile        | ✅    | ✅    |
| Edit any user           | ✅    | ❌    |
| Edit own profile        | ✅    | ✅    |
| Activate / deactivate   | ✅    | ❌    |
| Send password reset     | ✅    | ❌    |
| Delete user (hard)      | ❌    | ❌    | ← never; deactivate only

### User States
```
[Created] → [Active] ⇄ [Suspended] → (deactivated flag; hard delete never allowed)
```
