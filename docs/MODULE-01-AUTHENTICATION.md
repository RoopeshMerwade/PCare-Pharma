# MODULE 01 — AUTHENTICATION
## P.Care Pharma Management System v1.0
---

## 1. FUNCTIONAL DESIGN

### Roles
| Role  | Count | Access |
|-------|-------|--------|
| owner | 1     | All modules, read-write |
| staff | 4     | Billing, Inventory, Customers |

### Login Flow
1. User lands on /login
2. Enters email + password
3. Supabase Auth validates
4. Backend fetches profile + role from users table
5. JWT returned with role claim
6. Frontend stores token in httpOnly cookie (NOT localStorage)
7. Route guard enforces role-based access

### Session
- Token lifetime: 8h (owner), 12h (staff)
- Refresh token: 7 days, rotated on use
- Logout: invalidates session in Supabase, clears cookie

---

## 2. UI COMPONENTS

### Pages
- /login              → LoginPage
- /forgot-password    → ForgotPasswordPage
- /reset-password     → ResetPasswordPage

### Component Tree
```
LoginPage
  └── AuthLayout
        ├── BrandHeader        (P.Care logo + tagline)
        ├── LoginForm
        │     ├── EmailInput
        │     ├── PasswordInput (toggle visibility)
        │     ├── RememberMe
        │     ├── SubmitButton
        │     └── ForgotPasswordLink
        └── DemoLoginInfo (dev only, hidden in prod)
```

---

## 3. DATABASE TABLES

```sql
-- Supabase Auth handles auth.users internally
-- We extend with a public profile table

create table public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text        not null,
  phone       text,
  role        text        not null check (role in ('owner','staff')),
  is_active   boolean     not null default true,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Row Level Security
alter table public.users enable row level security;

-- Owner can read all users
create policy "owner_read_all" on public.users
  for select using (
    exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner')
  );

-- Each user can read and update their own profile
create policy "self_read" on public.users
  for select using (auth.uid() = id);

create policy "self_update" on public.users
  for update using (auth.uid() = id);

-- Audit log table
create table public.audit_logs (
  id          bigserial primary key,
  user_id     uuid references public.users(id),
  action      text    not null,  -- 'login','logout','login_failed'
  ip_address  inet,
  user_agent  text,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

-- Function: auto-update updated_at
create or replace function public.handle_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

create trigger users_updated_at before update on public.users
  for each row execute procedure public.handle_updated_at();
```

---

## 4. API ENDPOINTS

```
POST   /api/v1/auth/login              Login with email + password
POST   /api/v1/auth/logout             Invalidate session
POST   /api/v1/auth/refresh            Rotate refresh token
POST   /api/v1/auth/forgot-password    Send reset email
POST   /api/v1/auth/reset-password     Set new password with token
GET    /api/v1/auth/me                 Get current user profile
```

### Request / Response contracts

#### POST /api/v1/auth/login
```json
// Request
{ "email": "owner@pcare.in", "password": "••••••••" }

// 200 Success
{
  "user": { "id": "uuid", "full_name": "Vijay Sharma", "role": "owner", "is_active": true },
  "session": { "access_token": "eyJ...", "expires_in": 28800, "token_type": "bearer" }
}

// 401 Fail
{ "error": "INVALID_CREDENTIALS", "message": "Email or password is incorrect." }

// 403 Inactive
{ "error": "ACCOUNT_DISABLED", "message": "Your account has been disabled. Contact the owner." }
```

---

## 5. BACKEND LOGIC
