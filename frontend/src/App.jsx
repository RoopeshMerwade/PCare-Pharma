import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { ThemeProvider } from './hooks/useTheme';
import ProtectedRoute from './components/common/ProtectedRoute';
import { ToastProvider } from './ui/Toast';
import { TooltipProvider } from './ui/Tooltip';

// Auth
import LoginPage from './components/auth/LoginPage';
import ForgotPasswordPage from './components/auth/ForgotPasswordPage';
import ResetPasswordPage from './components/auth/ResetPasswordPage';
import UnauthorizedPage from './components/auth/UnauthorizedPage';

// Dashboards
import OwnerDashboard from './components/dashboard/OwnerDashboard';
import { StaffDashboard } from './components/dashboard/StaffDashboard';

// Shared modules
import MedicinesPage    from './components/medicines/MedicinesPage';
import InventoryPage    from './components/inventory/InventoryPage';
import BillingPage      from './components/billing/BillingPage';
import BillsListPage    from './components/billing/BillsListPage';
import CustomersPage    from './components/customers/CustomersPage';
import CustomerProfilePage from './components/customers/CustomerProfilePage';
import CustomerReturnsPage from './components/customer-returns/CustomerReturnsPage';
import SupplierInvoicesPage from './components/supplier-invoices/SupplierInvoicesPage';
import InvoiceReviewPage from './components/supplier-invoices/InvoiceReviewPage';
import StockRequisitionsPage from './components/stock-requisitions/StockRequisitionsPage';

// Owner-only modules
import UsersPage        from './components/users/UsersPage';
import CategoriesPage   from './components/categories/CategoriesPage';
import SuppliersPage    from './components/suppliers/SuppliersPage';
import PurchasesPage    from './components/purchases/PurchasesPage';
import { SupplierReturnsPage } from './components/supplier-returns/SupplierReturnsPage';
import ExpiryDashboardPage from './components/expiry/ExpiryDashboardPage';
import ReportsPage      from './components/reports/ReportsPage';
import { NotificationsPage, SettingsPage } from './components/settings/SettingsPages';
import AuditLogsPage from './components/audit-logs/AuditLogsPage';

function RoleRedirect() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={user.role === 'owner' ? '/dashboard' : '/staff'} replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        {/* Toasts and tooltips are app-wide services: mounting them at the root
            means a live region already exists when a message arrives, which is
            what makes the announcement reliable. */}
        <ToastProvider>
          <TooltipProvider>
            {/* Both v7 flags are opted into early, which is what silences the
                console warnings react-router v6.30 emits. Each was checked
                against this app rather than enabled to quiet the log:

                · v7_startTransition wraps router state updates in
                  startTransition. The hazard is a React.lazy component
                  suspending inside a transition with no Suspense boundary to
                  catch it — this app has neither, so there is nothing to
                  suspend.
                · v7_relativeSplatPath changes how RELATIVE paths resolve
                  inside a splat route. The only splat here is the 404 below,
                  and it navigates to an absolute "/", so no resolution
                  changes. Revisit if a nested splat ever gains relative links. */}
            <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
              <Routes>
                {/* Public */}
                <Route path="/login" element={<LoginPage />} />
                <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                <Route path="/reset-password" element={<ResetPasswordPage />} />
                <Route path="/unauthorized" element={<UnauthorizedPage />} />

                {/* Role redirect */}
                <Route path="/" element={<RoleRedirect />} />

                {/* Owner-only routes */}
                <Route path="/dashboard"        element={<ProtectedRoute role="owner" title="Dashboard"><OwnerDashboard /></ProtectedRoute>} />
                <Route path="/users"            element={<ProtectedRoute role="owner" title="Staff"><UsersPage /></ProtectedRoute>} />
                <Route path="/categories"       element={<ProtectedRoute role="owner" title="Categories"><CategoriesPage /></ProtectedRoute>} />
                <Route path="/suppliers"        element={<ProtectedRoute role="owner" title="Suppliers"><SuppliersPage /></ProtectedRoute>} />
                <Route path="/purchases"        element={<ProtectedRoute role="owner" title="Purchase Orders"><PurchasesPage /></ProtectedRoute>} />
                <Route path="/supplier-returns" element={<ProtectedRoute role="owner" title="Supplier Returns"><SupplierReturnsPage /></ProtectedRoute>} />
                <Route path="/expiry"           element={<ProtectedRoute role="owner" title="Expiry Tracker"><ExpiryDashboardPage /></ProtectedRoute>} />
                <Route path="/reports"          element={<ProtectedRoute role="owner" title="Reports"><ReportsPage /></ProtectedRoute>} />
                <Route path="/settings"         element={<ProtectedRoute role="owner" title="Settings"><SettingsPage /></ProtectedRoute>} />
                <Route path="/audit-logs"       element={<ProtectedRoute role="owner" title="Audit Log"><AuditLogsPage /></ProtectedRoute>} />

                {/* Both roles */}
                <Route path="/staff"            element={<ProtectedRoute title="Today"><StaffDashboard /></ProtectedRoute>} />
                <Route path="/medicines"        element={<ProtectedRoute title="Medicines"><MedicinesPage /></ProtectedRoute>} />
                <Route path="/inventory"        element={<ProtectedRoute title="Inventory"><InventoryPage /></ProtectedRoute>} />
                <Route path="/billing/new"      element={<ProtectedRoute title="New Bill"><BillingPage /></ProtectedRoute>} />
                <Route path="/billing"          element={<ProtectedRoute title="Bills"><BillsListPage /></ProtectedRoute>} />
                <Route path="/customers"        element={<ProtectedRoute title="Customers"><CustomersPage /></ProtectedRoute>} />
                <Route path="/customers/:id"    element={<ProtectedRoute><CustomerProfilePage /></ProtectedRoute>} />
                <Route path="/customer-returns" element={<ProtectedRoute title="Customer Returns"><CustomerReturnsPage /></ProtectedRoute>} />
                {/* Module 30. Both roles: staff raise the request and read
                    their own; only the owner approves and downloads, and both
                    of those guards are on the API route, not on this one. */}
                <Route path="/stock-requisitions" element={<ProtectedRoute title="Stock Requests"><StockRequisitionsPage /></ProtectedRoute>} />
                {/* Module 23. Both roles: staff run the goods-inward desk and
                    correct drafts; only the owner's Approve creates stock, and
                    that guard lives on the API route, not on this one. */}
                <Route path="/supplier-invoices"     element={<ProtectedRoute title="Supplier Invoices"><SupplierInvoicesPage /></ProtectedRoute>} />
                <Route path="/supplier-invoices/:id" element={<ProtectedRoute title="Invoice Review"><InvoiceReviewPage /></ProtectedRoute>} />
                <Route path="/notifications"    element={<ProtectedRoute title="Notifications"><NotificationsPage /></ProtectedRoute>} />

                {/* 404 */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </BrowserRouter>
          </TooltipProvider>
        </ToastProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}
