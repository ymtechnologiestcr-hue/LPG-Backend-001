import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import {
  assignComplaintToDeliveryBoy,
  createPenalty,
  createComplaint,
  createCustomerTransfer,
  createNewConnection,
  createNameChangeRequest,
  fetchRecentPenalties,
  fetchComplaints,
  fetchComplaintDrivers,
  fetchCustomers,
  fetchDashboardOverview,
  fetchRecentConnections,
  fetchRecentNameChanges,
  fetchRecentTransfers,
  lookupPenaltyCustomer,
  lookupNameChangeCustomer,
  lookupTransferCustomer,
  markPenaltyPaid,
  updateComplaintStatus,
  updateNameChangeApprovalStatus,
  uploadSupportingDocument,
  searchConnectionProducts,
} from "./services/complaintsApi";
import {
  addIocOtpManual,
  fetchCustomerDashboardDetails,
  fetchCustomerDirectory,
  fetchIocOtpSummary,
  fetchIocOtps,
  markOtpSent,
  AUTH_TOKEN_KEY,
  AUTH_USER_KEY,
} from "./services/complaintsApi";
import Login from "./components/Login";

const SIDEBAR_ITEMS = [
  "Dashboard",
  "Complaints",
  "New Connection",
  "Transfer",
  "Name Change",
  "PR Penalty",
  "IOC OTPs",
  "Customers",
  "Reports",
];

const SIDEBAR_ICONS = {
  Dashboard: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="7" height="9" x="3" y="3" rx="1"></rect>
      <rect width="7" height="5" x="14" y="3" rx="1"></rect>
      <rect width="7" height="9" x="14" y="12" rx="1"></rect>
      <rect width="7" height="5" x="3" y="16" rx="1"></rect>
    </svg>
  ),
  Complaints: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"></path>
      <path d="M12 9v4"></path>
      <path d="M12 17h.01"></path>
    </svg>
  ),
  "New Connection": (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"></path>
      <path d="m2 22 3-3"></path>
      <path d="M7.5 13.5 10 11"></path>
      <path d="M10.5 16.5 13 14"></path>
      <path d="m18 3-4 4h6l-4 4"></path>
    </svg>
  ),
  Transfer: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3 4 7l4 4"></path>
      <path d="M4 7h16"></path>
      <path d="m16 21 4-4-4-4"></path>
      <path d="M20 17H4"></path>
    </svg>
  ),
  "Name Change": (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11.5 15H7a4 4 0 0 0-4 4v2"></path>
      <path d="M21.378 16.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"></path>
      <circle cx="10" cy="7" r="4"></circle>
    </svg>
  ),
  "PR Penalty": (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"></path>
      <path d="M8 8h8"></path>
      <path d="M8 12h8"></path>
      <path d="m13 17-5-1h1a4 4 0 0 0 0-8"></path>
    </svg>
  ),
  "IOC OTPs": (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"></path>
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor"></circle>
    </svg>
  ),
  Customers: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
      <path d="M16 3.128a4 4 0 0 1 0 7.744"></path>
      <path d="M22 21v-2a4 4 0 0 0-3-3.87"></path>
      <circle cx="9" cy="7" r="4"></circle>
    </svg>
  ),
  Reports: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"></path>
      <path d="M14 2v5a1 1 0 0 0 1 1h5"></path>
      <path d="M8 18v-2"></path>
      <path d="M12 18v-4"></path>
      <path d="M16 18v-6"></path>
    </svg>
  ),
};

const DASHBOARD_CARD_ICONS = {
  pendingComplaints: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"></path>
      <path d="M12 9v4"></path>
      <path d="M12 17h.01"></path>
    </svg>
  ),
  leakageComplaints: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"></path>
    </svg>
  ),
  totalConnections: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"></path>
      <path d="m2 22 3-3"></path>
      <path d="M7.5 13.5 10 11"></path>
      <path d="M10.5 16.5 13 14"></path>
      <path d="m18 3-4 4h6l-4 4"></path>
    </svg>
  ),
  transferRequests: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3 4 7l4 4"></path>
      <path d="M4 7h16"></path>
      <path d="m16 21 4-4-4-4"></path>
      <path d="M20 17H4"></path>
    </svg>
  ),
  nameChangeRequests: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11.5 15H7a4 4 0 0 0-4 4v2"></path>
      <path d="M21.378 16.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"></path>
      <circle cx="10" cy="7" r="4"></circle>
    </svg>
  ),
  pendingManagerVerification: (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"></path>
      <path d="m9 12 2 2 4-4"></path>
    </svg>
  ),
};

const ISSUE_OPTIONS = [
  { value: "LEAKAGE", label: "Leakage" },
  { value: "CYLINDER_NOT_RECEIVED", label: "Cylinder Not Received" },
  { value: "BOOKING_DELAY", label: "Booking Delay" },
  { value: "METER_ISSUE", label: "Meter Issue" },
];

const DEFAULT_NEW_CONNECTION_FORM = {
  customerName: "",
  mobileNumber: "",
  address: "",
  idProofDetails: "",
  idProofUrl: "",
  idProofLabel: "",
  productDetails: "",
  productId: null,
  selectedProducts: [],
  depositAmount: "",
  gstAmount: "",
};

const DEFAULT_TRANSFER_FORM = {
  consumerNumber: "",
  existingName: "",
  existingCustomerId: null,
  existingProductDetails: "",
  newCustomerName: "",
  newCustomerMobile: "",
  newCustomerAddress: "",
  depositLiability: "",
  reason: "",
  isRegulatorReceived: false,
};

const DEFAULT_NAME_CHANGE_FORM = {
  consumerNumber: "",
  existingName: "",
  existingCustomerId: null,
  existingCustomerPhone: "",
  newName: "",
  serviceFee: "",
  documentUrl: "",
  documentLabel: "",
};

const DEFAULT_PR_PENALTY_FORM = {
  consumerNumber: "",
  customerName: "",
  customerId: null,
  penaltyReason: "",
  penaltyAmount: "100",
};

const normalizeStatus = (status) => String(status || "PENDING").replaceAll("_", " ");

const normalizeIssueLabel = (issue) => {
  const map = {
    LEAKAGE: "Leakage",
    CYLINDER_NOT_RECEIVED: "Cylinder Not Received",
    BOOKING_DELAY: "Booking Delay",
    METER_ISSUE: "Meter Issue",
  };

  return map[issue] || String(issue || "Issue").replaceAll("_", " ");
};

const getDaysAgo = (value) => {
  if (!value) return "Today";

  const createdAt = new Date(value);
  if (Number.isNaN(createdAt.getTime())) return "Today";

  const diff = Date.now() - createdAt.getTime();
  const days = Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
  return days === 0 ? "Today" : `${days} day${days === 1 ? "" : "s"} ago`;
};

const toText = (value) => (value == null ? "" : String(value));

const getDashboardStatusClass = (status) => {
  const text = String(status || "PENDING").toUpperCase().replaceAll("_", " ");
  if (text.includes("ASSIGNED")) return "assigned";
  if (text.includes("IN PROGRESS")) return "in-progress";
  if (text.includes("RESOLVED") || text.includes("CLOSED") || text.includes("PAID")) return "resolved";
  return "pending";
};

const mapTransferLookup = (record) => {
  if (!record) return null;

  // Do NOT include existingName here — that field is owned by the autosuggest input.
  return {
    existingCustomerId: record.existing_customer_id || record.customer_id || record.id || null,
    existingCustomerPhone: record.existing_phone || record.phone || record.mobile_number || "",
    existingProductDetails:
      record.existing_product_details || record.product_details || record.connection_details || record.items || "",
  };
};

const mapNameChangeLookup = (record) => {
  if (!record) return null;

  // Do NOT include existingName here — that field is owned by the autosuggest input.
  return {
    existingCustomerId: record.existing_customer_id || record.customer_id || record.id || null,
    existingCustomerPhone: record.existing_phone || record.phone || record.mobile_number || "",
  };
};

const mapPenaltyLookup = (record) => {
  if (!record) return null;

  // Do NOT include customerName here — that field is owned by the autosuggest input.
  return {
    customerId: record.id || record.customer_id || null,
    consumerNumber: record.consumerNumber || record.consumer_number || "",
  };
};

function Dashboard({ onSignOut }) {
  const [activeMenu, setActiveMenu] = useState("Dashboard");
  const [view, setView] = useState("list");
  const [step, setStep] = useState(1);

  const [complaints, setComplaints] = useState([]);
  const [complaintsLoading, setComplaintsLoading] = useState(false);
  const [complaintsSearch, setComplaintsSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [openComplaintActionId, setOpenComplaintActionId] = useState(null);
  const [complaintActionLoadingId, setComplaintActionLoadingId] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [driversLoading, setDriversLoading] = useState(false);
  const [assignModalComplaint, setAssignModalComplaint] = useState(null);
  const [selectedAssignDriverId, setSelectedAssignDriverId] = useState("");

  const [customers, setCustomers] = useState([]);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [customerSearch, setCustomerSearch] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [issueType, setIssueType] = useState("LEAKAGE");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [newConnectionForm, setNewConnectionForm] = useState(DEFAULT_NEW_CONNECTION_FORM);
  const [connectionSubmitting, setConnectionSubmitting] = useState(false);
  const [recentConnections, setRecentConnections] = useState([]);
  const [recentConnectionsLoading, setRecentConnectionsLoading] = useState(false);
  const [productSuggestions, setProductSuggestions] = useState([]);
  const [productSearchTimeout, setProductSearchTimeout] = useState(null);
  const [idProofUploading, setIdProofUploading] = useState(false);

  const [transferForm, setTransferForm] = useState(DEFAULT_TRANSFER_FORM);
  const [transferSubmitting, setTransferSubmitting] = useState(false);
  const [transferLookupLoading, setTransferLookupLoading] = useState(false);
  const [recentTransfers, setRecentTransfers] = useState([]);
  const [recentTransfersLoading, setRecentTransfersLoading] = useState(false);

  const [nameChangeForm, setNameChangeForm] = useState(DEFAULT_NAME_CHANGE_FORM);
  const [nameChangeSubmitting, setNameChangeSubmitting] = useState(false);
  const [nameChangeLookupLoading, setNameChangeLookupLoading] = useState(false);
  const [recentNameChanges, setRecentNameChanges] = useState([]);
  const [recentNameChangesLoading, setRecentNameChangesLoading] = useState(false);

  const [prPenaltyForm, setPrPenaltyForm] = useState(DEFAULT_PR_PENALTY_FORM);
  const [prPenaltySubmitting, setPrPenaltySubmitting] = useState(false);
  const [prPenaltyLookupLoading, setPrPenaltyLookupLoading] = useState(false);
  const [recentPenalties, setRecentPenalties] = useState([]);
  const [recentPenaltiesLoading, setRecentPenaltiesLoading] = useState(false);

  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const copyOtpClearTimeoutRef = useRef(null);

  const [iocOtpTab, setIocOtpTab] = useState("PENDING");
  const [iocOtps, setIocOtps] = useState([]);
  const [iocOtpsLoading, setIocOtpsLoading] = useState(false);
  const [iocOtpSummary, setIocOtpSummary] = useState({ todayReceived: 0, todayPending: 0, todaySent: 0, allPending: 0 });
  const [iocOtpDate, setIocOtpDate] = useState("");
  const [iocOtpDriverFilter, setIocOtpDriverFilter] = useState("ALL");
  const [showAddOtpForm, setShowAddOtpForm] = useState(false);
  const [addOtpSaleId, setAddOtpSaleId] = useState("");
  const [addOtpValue, setAddOtpValue] = useState("");
  const [addOtpSubmitting, setAddOtpSubmitting] = useState(false);

  const [customerDirectorySearch, setCustomerDirectorySearch] = useState("");
  const [customerDirectory, setCustomerDirectory] = useState([]);
  const [customerDirectoryLoading, setCustomerDirectoryLoading] = useState(false);
  const [selectedDashboardCustomerId, setSelectedDashboardCustomerId] = useState(null);
  const [customerDashboardDetails, setCustomerDashboardDetails] = useState(null);
  const [customerDashboardLoading, setCustomerDashboardLoading] = useState(false);

  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardOverview, setDashboardOverview] = useState({
    cards: {
      pendingComplaints: 0,
      leakageComplaints: 0,
      totalConnections: 0,
      transferRequests: 0,
      nameChangeRequests: 0,
      pendingManagerVerification: 0,
    },
    recentComplaints: [],
  });

  const [customerNameSuggestions, setCustomerNameSuggestions] = useState([]);
  const [activeSuggestionField, setActiveSuggestionField] = useState("");
  const suggestionTimeoutRef = useRef(null);

  const customerDetails = selectedCustomer || {};

  const filteredComplaints = useMemo(() => {
    return complaints.filter((item) => {
      const currentStatus = item.workflow_status || item.status;
      const statusMatched =
        statusFilter === "ALL" || String(currentStatus || "").toUpperCase() === statusFilter;
      const searchText = `${item.customer_name || ""} ${item.complaint_code || ""} ${item.customer_phone || ""} ${item.description || ""}`.toLowerCase();
      const searchMatched = !complaintsSearch || searchText.includes(complaintsSearch.toLowerCase());
      return statusMatched && searchMatched;
    });
  }, [complaints, complaintsSearch, statusFilter]);

  const connectionFinancials = useMemo(() => {
    const deposit = Number(newConnectionForm.depositAmount) || 0;
    const gst = Number(newConnectionForm.gstAmount) || 0;
    return { deposit, gst, total: deposit + gst };
  }, [newConnectionForm.depositAmount, newConnectionForm.gstAmount]);

  const iocDriverOptions = useMemo(() => {
    const seen = new Set();
    const result = [];
    for (const item of iocOtps) {
      if (item.driver_id && !seen.has(item.driver_id)) {
        seen.add(item.driver_id);
        result.push({ id: item.driver_id, name: item.driver_name || "Unknown" });
      }
    }
    return result;
  }, [iocOtps]);

  useEffect(() => {
    const loadCustomers = async () => {
      setCustomersLoading(true);
      try {
        const data = await fetchCustomers(customerSearch.trim());
        setCustomers(data);
      } catch (error) {
        setErrorMessage(error?.response?.data?.message || "Failed to load customers.");
      } finally {
        setCustomersLoading(false);
      }
    };

    if (activeMenu === "Complaints") {
      loadCustomers();
    }
  }, [activeMenu, customerSearch]);

  useEffect(() => {
    const loadComplaints = async () => {
      setComplaintsLoading(true);
      try {
        const data = await fetchComplaints(complaintsSearch.trim());
        setComplaints(Array.isArray(data) ? data : []);
      } catch (error) {
        setErrorMessage(error?.response?.data?.message || "Failed to load complaints.");
      } finally {
        setComplaintsLoading(false);
      }
    };

    if (activeMenu === "Complaints") {
      loadComplaints();
    }
  }, [activeMenu, complaintsSearch]);

  useEffect(() => {
    if (activeMenu !== "Complaints") return;

    const loadDrivers = async () => {
      setDriversLoading(true);
      try {
        const data = await fetchComplaintDrivers();
        setDrivers(Array.isArray(data) ? data : []);
      } catch (error) {
        setErrorMessage(error?.response?.data?.message || "Failed to load drivers.");
      } finally {
        setDriversLoading(false);
      }
    };

    loadDrivers();
  }, [activeMenu]);

  useEffect(() => {
    const loadRecentConnectionItems = async () => {
      setRecentConnectionsLoading(true);
      try {
        setRecentConnections(await fetchRecentConnections());
      } catch (error) {
        setErrorMessage(error?.response?.data?.message || "Failed to load recent connections.");
      } finally {
        setRecentConnectionsLoading(false);
      }
    };

    const loadRecentTransferItems = async () => {
      setRecentTransfersLoading(true);
      try {
        setRecentTransfers(await fetchRecentTransfers());
      } catch (error) {
        setErrorMessage(error?.response?.data?.message || "Failed to load recent transfers.");
      } finally {
        setRecentTransfersLoading(false);
      }
    };

    const loadRecentNameChangeItems = async () => {
      setRecentNameChangesLoading(true);
      try {
        setRecentNameChanges(await fetchRecentNameChanges());
      } catch (error) {
        setErrorMessage(error?.response?.data?.message || "Failed to load recent name changes.");
      } finally {
        setRecentNameChangesLoading(false);
      }
    };

    const loadRecentPenaltyItems = async () => {
      setRecentPenaltiesLoading(true);
      try {
        setRecentPenalties(await fetchRecentPenalties());
      } catch (error) {
        setErrorMessage(error?.response?.data?.message || "Failed to load recent penalties.");
      } finally {
        setRecentPenaltiesLoading(false);
      }
    };

    loadRecentConnectionItems();
    loadRecentTransferItems();
    loadRecentNameChangeItems();
    loadRecentPenaltyItems();
  }, []);

  useEffect(() => {
    const consumerNumber = transferForm.consumerNumber.trim();
    if (!consumerNumber) return;

    const timer = setTimeout(async () => {
      setTransferLookupLoading(true);
      try {
        const record = await lookupTransferCustomer({ consumerNumber });
        const mapped = mapTransferLookup(record);
        if (mapped) {
          setTransferForm((previous) => ({
            ...previous,
            ...mapped,
            existingName: previous.existingName || record?.name || "",
          }));
        }
      } catch (error) {
        setErrorMessage(error?.response?.data?.message || "Failed to lookup customer for transfer.");
      } finally {
        setTransferLookupLoading(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [transferForm.consumerNumber]);

  useEffect(() => {
    const consumerNumber = nameChangeForm.consumerNumber.trim();
    if (!consumerNumber) return;

    const timer = setTimeout(async () => {
      setNameChangeLookupLoading(true);
      try {
        const record = await lookupNameChangeCustomer({ consumerNumber });
        const mapped = mapNameChangeLookup(record);
        if (mapped) {
          setNameChangeForm((previous) => ({
            ...previous,
            ...mapped,
            existingName: previous.existingName || record?.name || "",
          }));
        }
      } catch (error) {
        setErrorMessage(error?.response?.data?.message || "Failed to lookup customer for name change.");
      } finally {
        setNameChangeLookupLoading(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [nameChangeForm.consumerNumber]);

  useEffect(() => {
    const consumerNumber = prPenaltyForm.consumerNumber.trim();
    if (!consumerNumber) return;

    const timer = setTimeout(async () => {
      setPrPenaltyLookupLoading(true);
      try {
        const record = await lookupPenaltyCustomer({ consumerNumber });
        const mapped = mapPenaltyLookup(record);
        if (mapped) {
          setPrPenaltyForm((previous) => ({
            ...previous,
            ...mapped,
            customerName: previous.customerName || record?.name || "",
          }));
        }
      } catch (error) {
        if (error?.response?.status !== 404) {
          setErrorMessage(error?.response?.data?.message || "Failed to lookup customer for penalty.");
        }
      } finally {
        setPrPenaltyLookupLoading(false);
      }
    }, 350);

    return () => clearTimeout(timer);
  }, [prPenaltyForm.consumerNumber]);


  useEffect(() => {
    if (activeMenu !== "IOC OTPs") return;

    const load = async () => {
      setIocOtpsLoading(true);
      try {
        const [otps, summary] = await Promise.all([
          fetchIocOtps({
            status: iocOtpTab === "ALL" ? undefined : iocOtpTab,
            date: iocOtpDate || undefined,
            driverId: iocOtpDriverFilter === "ALL" ? undefined : iocOtpDriverFilter,
          }),
          fetchIocOtpSummary(),
        ]);
        setIocOtps(otps);
        setIocOtpSummary(summary);
      } catch (error) {
        setErrorMessage(error?.response?.data?.message || "Failed to load IOC OTPs.");
      } finally {
        setIocOtpsLoading(false);
      }
    };

    load();
  }, [activeMenu, iocOtpTab, iocOtpDate, iocOtpDriverFilter]);

  useEffect(() => {
    if (activeMenu !== "Customers") return;

    const timer = setTimeout(async () => {
      setCustomerDirectoryLoading(true);
      try {
        const rows = await fetchCustomerDirectory(customerDirectorySearch.trim());
        setCustomerDirectory(rows);

        if (!selectedDashboardCustomerId && rows.length) {
          setSelectedDashboardCustomerId(Number(rows[0].id));
        }

        if (selectedDashboardCustomerId && !rows.some((item) => Number(item.id) === Number(selectedDashboardCustomerId))) {
          setSelectedDashboardCustomerId(rows.length ? Number(rows[0].id) : null);
        }
      } catch (error) {
        setErrorMessage(error?.response?.data?.message || "Failed to load customers dashboard list.");
      } finally {
        setCustomerDirectoryLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [activeMenu, customerDirectorySearch, selectedDashboardCustomerId]);

  useEffect(() => {
    if (activeMenu !== "Customers" || !selectedDashboardCustomerId) {
      setCustomerDashboardDetails(null);
      return;
    }

    const load = async () => {
      setCustomerDashboardLoading(true);
      try {
        const data = await fetchCustomerDashboardDetails(selectedDashboardCustomerId);
        setCustomerDashboardDetails(data);
      } catch (error) {
        setErrorMessage(error?.response?.data?.message || "Failed to load customer details.");
      } finally {
        setCustomerDashboardLoading(false);
      }
    };

    load();
  }, [activeMenu, selectedDashboardCustomerId]);

  useEffect(() => {
    if (activeMenu !== "Dashboard") return;

    const load = async () => {
      setDashboardLoading(true);
      try {
        const data = await fetchDashboardOverview();
        setDashboardOverview(data);
      } catch (error) {
        setErrorMessage(error?.response?.data?.message || "Failed to load dashboard overview.");
      } finally {
        setDashboardLoading(false);
      }
    };

    load();
  }, [activeMenu]);

  useEffect(() => {
    return () => {
      if (suggestionTimeoutRef.current) {
        clearTimeout(suggestionTimeoutRef.current);
      }
    };
  }, []);

  const openNewComplaint = () => {
    setView("new");
    setStep(1);
    setErrorMessage("");
    setSuccessMessage("");
  };

  const goBackToList = async () => {
    setView("list");
    setStep(1);
    setErrorMessage("");
    setOpenComplaintActionId(null);
    await fetchComplaints(complaintsSearch.trim()).then((data) => setComplaints(Array.isArray(data) ? data : []));
  };

  const handleSelectCustomer = (customer) => {
    setSelectedCustomer(customer);
  };

  const handleRegisterComplaint = async () => {
    if (!selectedCustomer?.id) {
      setErrorMessage("Please select a customer.");
      return;
    }

    if (!description.trim()) {
      setErrorMessage("Please enter the complaint description.");
      return;
    }

    try {
      setSubmitting(true);
      setErrorMessage("");
      await createComplaint({
        customerId: selectedCustomer.id,
        issueType,
        description,
      });
      setSuccessMessage("Complaint registered successfully.");
      setSelectedCustomer(null);
      setDescription("");
      setIssueType("LEAKAGE");
      setView("list");
      setStep(1);
      setOpenComplaintActionId(null);
      const updated = await fetchComplaints(complaintsSearch.trim());
      setComplaints(Array.isArray(updated) ? updated : []);
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Failed to register complaint.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleComplaintActions = (complaintId) => {
    setOpenComplaintActionId((current) => (current === complaintId ? null : complaintId));
  };

  const refreshComplaintList = async () => {
    const updated = await fetchComplaints(complaintsSearch.trim());
    setComplaints(Array.isArray(updated) ? updated : []);
  };

  const openAssignDriverModal = (complaint) => {
    setAssignModalComplaint(complaint);
    setSelectedAssignDriverId(complaint?.driver_id || "");
    setOpenComplaintActionId(null);
    setErrorMessage("");
    setSuccessMessage("");
  };

  const closeAssignDriverModal = () => {
    if (complaintActionLoadingId) return;
    setAssignModalComplaint(null);
    setSelectedAssignDriverId("");
  };

  const handleAssignComplaintToDelivery = async () => {
    if (!assignModalComplaint?.id) return;

    if (!selectedAssignDriverId) {
      setErrorMessage("Please choose a driver.");
      return;
    }

    try {
      setComplaintActionLoadingId(assignModalComplaint.id);
      setErrorMessage("");
      setSuccessMessage("");
      await assignComplaintToDeliveryBoy(assignModalComplaint.id, selectedAssignDriverId);
      setSuccessMessage("Complaint assigned to delivery boy.");
      setAssignModalComplaint(null);
      setSelectedAssignDriverId("");
      await refreshComplaintList();
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Failed to assign complaint.");
    } finally {
      setComplaintActionLoadingId(null);
    }
  };

  const handleChangeComplaintStatus = async (complaintId, status, successText) => {
    try {
      setComplaintActionLoadingId(complaintId);
      setErrorMessage("");
      setSuccessMessage("");
      await updateComplaintStatus(complaintId, status);
      setSuccessMessage(successText);
      setOpenComplaintActionId(null);
      await refreshComplaintList();
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Failed to update complaint status.");
    } finally {
      setComplaintActionLoadingId(null);
    }
  };

  const handleMenuClick = (item) => {
    setActiveMenu(item);
    setErrorMessage("");
    setSuccessMessage("");
    if (item !== "Complaints") {
      setView("list");
      setStep(1);
    }
  };

  const handleConnectionInputChange = (event) => {
    const { name, value } = event.target;
    setNewConnectionForm((previous) => ({ ...previous, [name]: value }));
  };

  const searchCustomerNameSuggestions = (field, query) => {
    setActiveSuggestionField(field);

    if (suggestionTimeoutRef.current) {
      clearTimeout(suggestionTimeoutRef.current);
    }

    const trimmed = String(query || "").trim();
    if (trimmed.length < 2) {
      setCustomerNameSuggestions([]);
      return;
    }

    suggestionTimeoutRef.current = setTimeout(async () => {
      try {
        const rows = await fetchCustomers(trimmed);
        setCustomerNameSuggestions(Array.isArray(rows) ? rows : []);
      } catch (_error) {
        setCustomerNameSuggestions([]);
      }
    }, 250);
  };

  const clearCustomerNameSuggestions = () => {
    setActiveSuggestionField("");
    setCustomerNameSuggestions([]);
  };

  const handleSelectSuggestedCustomer = (field, customer) => {
    const name = String(customer?.name || "");
    const phone = String(customer?.phone || "");
    const address = String(customer?.address || "");
    const consumerNumber = String(customer?.consumer_number || "");
    const customerId = customer?.id || null;

    if (field === "new-connection") {
      setNewConnectionForm((previous) => ({
        ...previous,
        customerName: name,
        mobileNumber: phone || previous.mobileNumber,
        address: address || previous.address,
      }));
    }

    if (field === "transfer-existing") {
      setTransferForm((previous) => ({
        ...previous,
        existingName: name,
        consumerNumber: consumerNumber || previous.consumerNumber,
        existingCustomerId: customerId,
      }));
    }

    if (field === "transfer-new") {
      setTransferForm((previous) => ({
        ...previous,
        newCustomerName: name,
        newCustomerMobile: phone || previous.newCustomerMobile,
        newCustomerAddress: address || previous.newCustomerAddress,
      }));
    }

    if (field === "name-change-existing") {
      setNameChangeForm((previous) => ({
        ...previous,
        existingName: name,
        consumerNumber: consumerNumber || previous.consumerNumber,
        existingCustomerId: customerId,
        existingCustomerPhone: phone || previous.existingCustomerPhone,
      }));
    }

    if (field === "pr-penalty") {
      setPrPenaltyForm((previous) => ({
        ...previous,
        customerName: name,
        customerId,
        consumerNumber: consumerNumber || previous.consumerNumber,
      }));
    }

    clearCustomerNameSuggestions();
  };

  const handleConnectionCustomerNameChange = (event) => {
    const value = event.target.value;
    setNewConnectionForm((previous) => ({ ...previous, customerName: value }));
    searchCustomerNameSuggestions("new-connection", value);
  };

  const handleTransferExistingNameChange = (event) => {
    const value = event.target.value;
    setTransferForm((previous) => ({
      ...previous,
      existingName: value,
      existingCustomerId: null,
      existingProductDetails: "",
    }));
    searchCustomerNameSuggestions("transfer-existing", value);
  };

  const handleTransferNewCustomerNameChange = (event) => {
    const value = event.target.value;
    setTransferForm((previous) => ({ ...previous, newCustomerName: value }));
    searchCustomerNameSuggestions("transfer-new", value);
  };

  const handleNameChangeExistingNameChange = (event) => {
    const value = event.target.value;
    setNameChangeForm((previous) => ({
      ...previous,
      existingName: value,
      existingCustomerId: null,
      existingCustomerPhone: "",
    }));
    searchCustomerNameSuggestions("name-change-existing", value);
  };

  const handlePrPenaltyCustomerNameChange = (event) => {
    const value = event.target.value;
    setPrPenaltyForm((previous) => ({
      ...previous,
      customerName: value,
      customerId: null,
    }));
    searchCustomerNameSuggestions("pr-penalty", value);
  };

  const handleTransferInputChange = (event) => {
    const { name, value } = event.target;
    setTransferForm((previous) => {
      const next = { ...previous, [name]: value };
      if (name === "consumerNumber" || name === "existingName") {
        next.existingCustomerId = null;
        next.existingProductDetails = "";
      }
      return next;
    });
  };

  const handleNameChangeInputChange = (event) => {
    const { name, value } = event.target;
    setNameChangeForm((previous) => {
      const next = { ...previous, [name]: value };
      if (name === "consumerNumber" || name === "existingName") {
        next.existingCustomerId = null;
        next.existingCustomerPhone = "";
      }
      return next;
    });
  };

  const handlePrPenaltyInputChange = (event) => {
    const { name, value } = event.target;

    setPrPenaltyForm((previous) => {
      const next = {
        ...previous,
        [name]: value,
      };

      if (name === "consumerNumber" || name === "customerName") {
        next.customerId = null;
      }

      return next;
    });
  };

  const handleNameChangeDocumentUpload = async (event) => {
    const file = event.target.files?.[0] || null;
    if (!file) return;

    try {
      setErrorMessage("");
      const url = await uploadSupportingDocument(file);
      setNameChangeForm((previous) => ({
        ...previous,
        documentUrl: url || "",
        documentLabel: file.name,
      }));
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Failed to upload supporting document.");
    }
  };

  const handleProductSearch = (value) => {
    setNewConnectionForm((previous) => ({
      ...previous,
      productDetails: value,
    }));

    if (productSearchTimeout) clearTimeout(productSearchTimeout);

    if (!value.trim()) {
      setProductSuggestions([]);
      return;
    }

    const timeout = setTimeout(async () => {
      try {
        const rows = await searchConnectionProducts(value.trim());
        setProductSuggestions(rows);
      } catch (_error) {
        setProductSuggestions([]);
      }
    }, 250);
    setProductSearchTimeout(timeout);
  };

  const handleSelectProduct = (product) => {
    const nextProduct = {
      id: Number(product.id),
      name: product.name || "Product",
      type: product.type || "",
      price: Number(product.price || 0),
    };

    setNewConnectionForm((previous) => ({
      ...previous,
      productDetails: "",
      productId: previous.productId || nextProduct.id,
      selectedProducts: previous.selectedProducts.some((item) => Number(item.id) === nextProduct.id)
        ? previous.selectedProducts
        : [...previous.selectedProducts, nextProduct],
    }));
    setProductSuggestions([]);
  };

  const handleRemoveConnectionProduct = (productId) => {
    setNewConnectionForm((previous) => {
      const selectedProducts = previous.selectedProducts.filter((item) => Number(item.id) !== Number(productId));
      return {
        ...previous,
        selectedProducts,
        productId: selectedProducts[0]?.id || null,
      };
    });
  };

  const handleIdProofUpload = async (event) => {
    const file = event.target.files?.[0] || null;
    if (!file) return;
    try {
      setIdProofUploading(true);
      setErrorMessage("");
      const url = await uploadSupportingDocument(file);
      setNewConnectionForm((previous) => ({
        ...previous,
        idProofUrl: url || "",
        idProofLabel: file.name,
      }));
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Failed to upload ID proof.");
    } finally {
      setIdProofUploading(false);
    }
  };

  const handleSendToCashier = async () => {
    if (!newConnectionForm.customerName.trim()) {
      setErrorMessage("Customer name is required.");
      return;
    }
    if (!newConnectionForm.mobileNumber.trim()) {
      setErrorMessage("Mobile number is required.");
      return;
    }
    if (!newConnectionForm.address.trim()) {
      setErrorMessage("Address is required.");
      return;
    }

    try {
      setConnectionSubmitting(true);
      setErrorMessage("");
      await createNewConnection({
        customerName: newConnectionForm.customerName,
        mobileNumber: newConnectionForm.mobileNumber,
        address: newConnectionForm.address,
        idProofDetails: newConnectionForm.idProofDetails,
        idProofUrl: newConnectionForm.idProofUrl,
        productDetails: newConnectionForm.selectedProducts
          .map((item) => `${item.name}${item.type ? ` (${item.type})` : ""}`)
          .join(", "),
        productId: newConnectionForm.selectedProducts[0]?.id || newConnectionForm.productId,
        products: newConnectionForm.selectedProducts.map((item) => ({
          productId: item.id,
        })),
        depositAmount: connectionFinancials.deposit,
        gstAmount: connectionFinancials.gst,
        totalAmount: connectionFinancials.total,
      });
      setSuccessMessage("New connection sent successfully.");
      setNewConnectionForm(DEFAULT_NEW_CONNECTION_FORM);
      setProductSuggestions([]);
      setRecentConnections(await fetchRecentConnections());
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Failed to send new connection.");
    } finally {
      setConnectionSubmitting(false);
    }
  };

  const handleSendTransferRequest = async () => {
    if (!transferForm.existingCustomerId) {
      setErrorMessage("Please lookup and select an existing customer first.");
      return;
    }
    if (!transferForm.newCustomerName.trim()) {
      setErrorMessage("New customer name is required.");
      return;
    }
    if (!transferForm.newCustomerMobile.trim()) {
      setErrorMessage("New customer mobile is required.");
      return;
    }
    if (!transferForm.newCustomerAddress.trim()) {
      setErrorMessage("New customer address is required.");
      return;
    }
    if (!transferForm.reason.trim()) {
      setErrorMessage("Reason for transfer is required.");
      return;
    }

    try {
      setTransferSubmitting(true);
      setErrorMessage("");
      await createCustomerTransfer({
        existingCustomerId: transferForm.existingCustomerId,
        newCustomerName: transferForm.newCustomerName,
        newCustomerPhone: transferForm.newCustomerMobile,
        newCustomerAddress: transferForm.newCustomerAddress,
        depositLiability: Number(transferForm.depositLiability) || 0,
        reason: transferForm.reason,
        isRegulatorReceived: transferForm.isRegulatorReceived ? 1 : 0,
      });
      setSuccessMessage("Transfer request sent successfully.");
      setTransferForm(DEFAULT_TRANSFER_FORM);
      setRecentTransfers(await fetchRecentTransfers());
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Failed to create transfer request.");
    } finally {
      setTransferSubmitting(false);
    }
  };

  const handleCreateNameChangeRequest = async () => {
    if (!nameChangeForm.existingCustomerId) {
      setErrorMessage("Please lookup and select an existing customer first.");
      return;
    }
    if (!nameChangeForm.newName.trim()) {
      setErrorMessage("New name is required.");
      return;
    }
    if (!nameChangeForm.documentUrl) {
      setErrorMessage("Please upload the supporting document.");
      return;
    }

    try {
      setNameChangeSubmitting(true);
      setErrorMessage("");
      await createNameChangeRequest({
        customerId: nameChangeForm.existingCustomerId,
        newName: nameChangeForm.newName,
        serviceFee: Number(nameChangeForm.serviceFee) || 0,
        documentUrl: nameChangeForm.documentUrl,
      });
      setSuccessMessage("Name change request created successfully.");
      setNameChangeForm(DEFAULT_NAME_CHANGE_FORM);
      setRecentNameChanges(await fetchRecentNameChanges());
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Failed to create name change request.");
    } finally {
      setNameChangeSubmitting(false);
    }
  };

  const handleRecordPenalty = async () => {
    if (!prPenaltyForm.customerId) {
      setErrorMessage("Please enter valid consumer number or customer name.");
      return;
    }

    if (!prPenaltyForm.penaltyReason.trim()) {
      setErrorMessage("Penalty reason is required.");
      return;
    }

    const amount = Number(prPenaltyForm.penaltyAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setErrorMessage("Penalty amount must be greater than 0.");
      return;
    }

    try {
      setPrPenaltySubmitting(true);
      setErrorMessage("");

      await createPenalty({
        customerId: prPenaltyForm.customerId,
        penaltyReason: prPenaltyForm.penaltyReason,
        penaltyAmount: amount,
      });

      setSuccessMessage("Penalty recorded successfully.");
      setPrPenaltyForm(DEFAULT_PR_PENALTY_FORM);
      setRecentPenalties(await fetchRecentPenalties());
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Failed to record penalty.");
    } finally {
      setPrPenaltySubmitting(false);
    }
  };

  const handleMarkPenaltyPaid = async (penaltyId) => {
    try {
      setErrorMessage("");
      await markPenaltyPaid(penaltyId);
      setSuccessMessage("Penalty marked as paid.");
      setRecentPenalties(await fetchRecentPenalties());
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Failed to mark penalty as paid.");
    }
  };


  const handleIocOtpTabChange = (nextTab) => {
    setIocOtpTab(nextTab);
  };

  const handleMarkOtpSent = async (otpId) => {
    try {
      setErrorMessage("");
      await markOtpSent(otpId);
      setSuccessMessage("OTP marked as sent.");

      const [otps, summary] = await Promise.all([
        fetchIocOtps({
          status: iocOtpTab === "ALL" ? undefined : iocOtpTab,
          date: iocOtpDate || undefined,
          driverId: iocOtpDriverFilter === "ALL" ? undefined : iocOtpDriverFilter,
        }),
        fetchIocOtpSummary(),
      ]);

      setIocOtps(otps);
      setIocOtpSummary(summary);
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Failed to mark OTP as sent.");
    }
  };

  const handleCopyOtp = (otpValue) => {
    if (copyOtpClearTimeoutRef.current) {
      clearTimeout(copyOtpClearTimeoutRef.current);
    }

    navigator.clipboard.writeText(String(otpValue || "")).then(
      () => {
        setSuccessMessage("OTP copied to clipboard.");
        copyOtpClearTimeoutRef.current = setTimeout(() => {
          setSuccessMessage((currentMessage) =>
            currentMessage === "OTP copied to clipboard." ? "" : currentMessage
          );
        }, 3000);
      },
      () => setErrorMessage("Failed to copy OTP.")
    );
  };

  useEffect(() => {
    return () => {
      if (copyOtpClearTimeoutRef.current) {
        clearTimeout(copyOtpClearTimeoutRef.current);
      }
    };
  }, []);

  const handleAddIocOtp = async () => {
    if (!addOtpSaleId.trim()) {
      setErrorMessage("Sale ID is required.");
      return;
    }

    if (!addOtpValue.trim()) {
      setErrorMessage("OTP is required.");
      return;
    }

    try {
      setAddOtpSubmitting(true);
      setErrorMessage("");
      await addIocOtpManual({ saleId: Number(addOtpSaleId), otp: addOtpValue.trim() });
      setSuccessMessage("OTP added successfully.");
      setShowAddOtpForm(false);
      setAddOtpSaleId("");
      setAddOtpValue("");

      const [otps, summary] = await Promise.all([
        fetchIocOtps({
          status: iocOtpTab === "ALL" ? undefined : iocOtpTab,
          date: iocOtpDate || undefined,
          driverId: iocOtpDriverFilter === "ALL" ? undefined : iocOtpDriverFilter,
        }),
        fetchIocOtpSummary(),
      ]);

      setIocOtps(otps);
      setIocOtpSummary(summary);
    } catch (error) {
      setErrorMessage(error?.response?.data?.message || "Failed to add OTP.");
    } finally {
      setAddOtpSubmitting(false);
    }
  };

  const handleDownloadIocOtpsSheet = () => {
    if (!iocOtps.length) {
      setErrorMessage("No OTP data to download.");
      return;
    }

    // Prepare CSV header
    const headers = ["Date", "Driver", "Customer", "Consumer number", "OTP", "Status", "Sent At"];
    
    // Prepare CSV rows
    const rows = iocOtps.map((item) => [
      item.created_at_formatted || "",
      item.driver_name || "-",
      item.customer_name || "-",
      item.consumer_number || "-",
      item.otp || "",
      (String(item.status || "PENDING").toUpperCase() === "PENDING" ? "Pending" : "Sent"),
      item.created_at || "",
    ]);

    // Combine headers and rows
    const csvContent = [
      headers.map((h) => `"${h}"`).join(","),
      ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")),
    ].join("\n");

    // Create blob and download
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    
    link.setAttribute("href", url);
    link.setAttribute("download", `IOC_OTPs_${new Date().toISOString().split("T")[0]}.csv`);
    link.style.visibility = "hidden";
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    setSuccessMessage("IOC OTPs data downloaded successfully.");
  };

  const handleClearCustomerSelection = () => {
    setSelectedDashboardCustomerId(null);
    setCustomerDashboardDetails(null);
  };


  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div className="brand-head">
          <div className="brand-icon">L</div>
          <div>
            <p className="brand-title">LPG Support</p>
            <p className="brand-subtitle">Agency ERP</p>
          </div>
        </div>

        <p className="menu-label">Menu</p>

        <nav className="side-nav">
          {SIDEBAR_ITEMS.map((item) => (
            <button
              key={item}
              type="button"
              className={`nav-link ${activeMenu === item ? "active" : ""}`}
              onClick={() => handleMenuClick(item)}
            >
              <span className="nav-icon">{SIDEBAR_ICONS[item]}</span>
              <span>{item}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button type="button" className="nav-link logout-link" onClick={onSignOut}>
            <span className="nav-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                <polyline points="16 17 21 12 16 7"></polyline>
                <line x1="21" x2="9" y1="12" y2="12"></line>
              </svg>
            </span>
            <span>Logout</span>
          </button>
        </div>
      </aside>

      <main className="content">
        <header className="page-head">
          <div>
            <h2>
              {activeMenu === "Complaints"
                ? view === "new"
                  ? "New Complaint"
                  : "Complaints"
                : activeMenu}
            </h2>
            <p className="subtitle">
              {activeMenu === "Complaints"
                ? view === "new"
                  ? "Register a new customer complaint in 3 quick steps"
                  : "Log, assign and track customer complaints"
                : activeMenu === "Dashboard"
                  ? "Live overview of customer support operations"
                : activeMenu === "New Connection"
                  ? "Onboard new LPG customers"
                  : activeMenu === "Transfer"
                    ? "Transfer LPG connection to a new customer"
                    : activeMenu === "Name Change"
                      ? "Update customer name on connection"
                      : activeMenu === "PR Penalty"
                        ? "Record and track penalty fees"
                      : activeMenu === "IOC OTPs"
                        ? "OTPs received from drivers - copy  and send to IOC"
                      : activeMenu === "Customers"
                        ? "Search and view customer history"
                      : "This section will be available soon"}
            </p>
          </div>

          {activeMenu === "Complaints" && view === "new" ? (
            <button type="button" className="secondary-btn" onClick={goBackToList}>
              Back to Complaints
            </button>
          ) : null}

          {activeMenu === "Complaints" && view === "list" ? (
            <button type="button" className="primary-btn" onClick={openNewComplaint}>
              + New Complaint
            </button>
          ) : null}

          {activeMenu === "IOC OTPs" ? (
            <button type="button" className="primary-btn" onClick={() => setShowAddOtpForm((prev) => !prev)}>
              + Add OTP
            </button>
          ) : null}
        </header>

        {errorMessage ? <p className="msg error">{errorMessage}</p> : null}
        {successMessage ? <p className="msg success">{successMessage}</p> : null}

        {activeMenu === "Dashboard" ? (
          <section className="support-dashboard-section">
            <div className="support-dashboard-cards">
              <article className="support-kpi-card">
                <div>
                  <p className="support-kpi-label">Pending Complaints</p>
                  <strong>{dashboardOverview.cards.pendingComplaints}</strong>
                </div>
                <span className="support-kpi-icon warning">{DASHBOARD_CARD_ICONS.pendingComplaints}</span>
              </article>

              <article className="support-kpi-card">
                <div>
                  <p className="support-kpi-label">Leakage Complaints</p>
                  <strong>{dashboardOverview.cards.leakageComplaints}</strong>
                </div>
                <span className="support-kpi-icon danger">{DASHBOARD_CARD_ICONS.leakageComplaints}</span>
              </article>

              <article className="support-kpi-card">
                <div>
                  <p className="support-kpi-label">Total Connections</p>
                  <strong>{dashboardOverview.cards.totalConnections}</strong>
                </div>
                <span className="support-kpi-icon sky">{DASHBOARD_CARD_ICONS.totalConnections}</span>
              </article>

              <article className="support-kpi-card">
                <div>
                  <p className="support-kpi-label">Transfer Requests</p>
                  <strong>{dashboardOverview.cards.transferRequests}</strong>
                </div>
                <span className="support-kpi-icon sky">{DASHBOARD_CARD_ICONS.transferRequests}</span>
              </article>

              <article className="support-kpi-card">
                <div>
                  <p className="support-kpi-label">Name Change Requests</p>
                  <strong>{dashboardOverview.cards.nameChangeRequests}</strong>
                </div>
                <span className="support-kpi-icon sky">{DASHBOARD_CARD_ICONS.nameChangeRequests}</span>
              </article>

              <article className="support-kpi-card">
                <div>
                  <p className="support-kpi-label">Pending Manager Verification</p>
                  <strong>{dashboardOverview.cards.pendingManagerVerification}</strong>
                </div>
                <span className="support-kpi-icon warning">{DASHBOARD_CARD_ICONS.pendingManagerVerification}</span>
              </article>
            </div>

            <article className="support-recent-card">
              <div className="support-recent-head">
                <div>
                  <h3>Recent Complaints</h3>
                  <p>Latest tickets logged by customers</p>
                </div>
                <button type="button" className="support-view-all" onClick={() => handleMenuClick("Complaints")}>
                  View all
                </button>
              </div>

              {dashboardLoading ? <p className="muted">Loading dashboard overview...</p> : null}

              <div className="support-recent-list">
                {!dashboardLoading && !dashboardOverview.recentComplaints?.length ? (
                  <p className="muted">No complaints available.</p>
                ) : null}

                {dashboardOverview.recentComplaints?.map((item) => (
                  <article key={item.id} className="support-recent-item">
                    <div className="support-recent-main">
                      <p className="support-recent-name">
                        {item.customerName}
                        <span>- {item.consumerNumber}</span>
                      </p>
                      <p className="support-recent-desc">{item.description || "No description provided."}</p>
                    </div>

                    <div className="support-recent-tags">
                      <div className="support-recent-chip-row">
                        <span className={`support-chip issue ${String(item.issueType || "Other").toLowerCase()}`}>
                          {item.issueType}
                        </span>
                        <span className={`support-chip status ${getDashboardStatusClass(item.status)}`}>
                          {item.status}
                        </span>
                      </div>
                      <p className="support-recent-time">{getDaysAgo(item.createdAt)}</p>
                    </div>
                  </article>
                ))}
              </div>
            </article>
          </section>
        ) : null}

        {activeMenu === "Complaints" && view === "list" ? (
          <section className="panel">
            <div className="filters-row">
              <input
                value={complaintsSearch}
                onChange={(event) => setComplaintsSearch(event.target.value)}
                placeholder="Search by name, consumer no, mobile..."
              />
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="ALL">All statuses</option>
                <option value="OPEN">Open</option>
                <option value="ASSIGNED_TO_DELIVERY_BOY">Assigned To Delivery Boy</option>
                <option value="IN_PROGRESS">In Progress</option>
                <option value="RESOLVED">Resolved</option>
              </select>
            </div>

            {complaintsLoading ? <p className="muted">Loading complaints...</p> : null}

            <div className="complaints-list">
              {filteredComplaints.map((item) => (
                <article className="complaint-row" key={item.id}>
                  <div className="row-main">
                    <p className="name-line">
                      <strong>{item.customer_name}</strong>
                      <span className="meta-inline">{item.consumer_number || item.complaint_code || "-"}</span>
                      <span className="meta-inline">{item.customer_phone || "-"}</span>
                    </p>
                    <p className="address-line">{item.address || "Address unavailable"}</p>
                    <p className="description-line">{item.description}</p>
                    {item.assigned_to_name || item.assigned_to ? (
                      <p className="assigned-line">Assigned to: {item.assigned_to_name || item.assigned_to}</p>
                    ) : null}
                    <p className="time-line">{getDaysAgo(item.created_at)}</p>
                  </div>

                  <div className="row-tags">
                    {/** Show workflow status (e.g. ASSIGNED_TO_DELIVERY_BOY) when available. */}
                    {(() => {
                      const currentStatus = item.workflow_status || item.status;
                      return (
                        <div className="chip-row">
                          <span className={`chip chip-issue ${String(item.issue_type).toLowerCase()}`}>
                            {normalizeIssueLabel(item.issue_type)}
                          </span>
                          <span
                            className={`chip chip-status ${normalizeStatus(currentStatus)
                              .toLowerCase()
                              .replaceAll(" ", "-")}`}
                          >
                            {normalizeStatus(currentStatus)}
                          </span>
                        </div>
                      );
                    })()}
                    <div className="actions-wrap">
                      <button
                        type="button"
                        className="action-btn"
                        onClick={() => handleToggleComplaintActions(item.id)}
                        disabled={complaintActionLoadingId === item.id}
                      >
                        Actions
                      </button>

                      {openComplaintActionId === item.id ? (
                        <div className="actions-menu">
                          <button
                            type="button"
                            onClick={() => openAssignDriverModal(item)}
                            disabled={complaintActionLoadingId === item.id}
                          >
                            Assign To Delivery Boy
                          </button>
                          <button
                            type="button"
                            onClick={() => handleChangeComplaintStatus(item.id, "IN_PROGRESS", "Complaint marked in progress.")}
                            disabled={complaintActionLoadingId === item.id}
                          >
                            Mark In Progress
                          </button>
                          <button
                            type="button"
                            onClick={() => handleChangeComplaintStatus(item.id, "RESOLVED", "Complaint marked completed.")}
                            disabled={complaintActionLoadingId === item.id}
                          >
                            Mark Completed
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </article>
              ))}

              {!filteredComplaints.length && !complaintsLoading ? (
                <p className="muted">No complaints found for this filter.</p>
              ) : null}
            </div>

            {assignModalComplaint ? (
              <div className="modal-backdrop" role="presentation" onMouseDown={closeAssignDriverModal}>
                <section
                  className="assign-driver-modal"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="assign-driver-title"
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <div className="modal-title-row">
                    <div>
                      <p className="modal-eyebrow">Assign complaint</p>
                      <h2 id="assign-driver-title">Choose delivery driver</h2>
                    </div>
                    <button type="button" className="modal-close-btn" onClick={closeAssignDriverModal}>
                      X
                    </button>
                  </div>

                  <div className="assign-complaint-summary">
                    <strong>{assignModalComplaint.customer_name}</strong>
                    <span>{assignModalComplaint.consumer_number || assignModalComplaint.complaint_code}</span>
                    <p>{assignModalComplaint.description}</p>
                  </div>

                  {driversLoading ? <p className="muted">Loading drivers...</p> : null}

                  <div className="driver-choice-list">
                    {!driversLoading && !drivers.length ? (
                      <p className="muted">No drivers found.</p>
                    ) : null}

                    {drivers.map((driver) => (
                      <button
                        type="button"
                        key={driver.id}
                        className={`driver-choice ${Number(selectedAssignDriverId) === Number(driver.id) ? "selected" : ""}`}
                        onClick={() => setSelectedAssignDriverId(driver.id)}
                      >
                        <span>
                          <strong>{driver.name || "Driver"}</strong>
                          <small>{driver.vehicle || "Vehicle N/A"}</small>
                        </span>
                        <span className="driver-choice-radio" aria-hidden="true" />
                      </button>
                    ))}
                  </div>

                  <div className="modal-actions">
                    <button type="button" className="secondary-btn" onClick={closeAssignDriverModal}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="primary-btn"
                      onClick={handleAssignComplaintToDelivery}
                      disabled={!selectedAssignDriverId || complaintActionLoadingId === assignModalComplaint.id}
                    >
                      {complaintActionLoadingId === assignModalComplaint.id ? "Assigning..." : "Assign Driver"}
                    </button>
                  </div>
                </section>
              </div>
            ) : null}
          </section>
        ) : null}

        {activeMenu === "Complaints" && view !== "list" ? (
          <section className="new-complaint-flow">
            <div className="stepper-bar">
              <button type="button" className={`step-pill ${step >= 1 ? "done" : ""} ${step === 1 ? "active" : ""}`}>
                Customer
              </button>
              <span className="step-line" />
              <button type="button" className={`step-pill ${step >= 2 ? "done" : ""} ${step === 2 ? "active" : ""}`}>
                Issue Details
              </button>
              <span className="step-line" />
              <button type="button" className={`step-pill ${step === 3 ? "active" : ""} ${step > 3 ? "done" : ""}`}>
                Review
              </button>
            </div>

            {step === 1 ? (
              <div className="wizard-card">
                <h3>Find existing customer</h3>
                <p className="wizard-subtitle">Search by name, consumer number or mobile.</p>
                <input
                  value={customerSearch}
                  onChange={(event) => setCustomerSearch(event.target.value)}
                  placeholder="Search customers..."
                />

                {customersLoading ? <p className="muted">Loading customers...</p> : null}

                <div className="customer-search-results">
                  {customers.map((customer) => (
                    <button
                      key={customer.id}
                      type="button"
                      className={`customer-result ${selectedCustomer?.id === customer.id ? "active" : ""}`}
                      onClick={() => handleSelectCustomer(customer)}
                    >
                      <div>
                        <p className="result-name">
                          {customer.name} <span>{customer.consumer_number}</span>
                        </p>
                        <p className="result-meta">
                          {customer.phone || "-"} {customer.address ? `• ${customer.address}` : ""}
                        </p>
                      </div>
                      <span className="result-icon">+</span>
                    </button>
                  ))}
                </div>

                <div className="details-grid">
                  <div>
                    <label>Consumer Number</label>
                    <input value={toText(customerDetails.consumer_number)} readOnly />
                  </div>
                  <div>
                    <label>Customer Name *</label>
                    <input value={toText(customerDetails.name)} readOnly />
                  </div>
                  <div>
                    <label>Mobile Number *</label>
                    <input value={toText(customerDetails.phone)} readOnly />
                  </div>
                  <div>
                    <label>Address</label>
                    <input value={toText(customerDetails.address)} readOnly />
                  </div>
                </div>

                <div className="flow-actions spread">
                  <button type="button" className="secondary-btn" onClick={goBackToList}>
                    Back
                  </button>
                  <button type="button" className="primary-btn" disabled={!selectedCustomer} onClick={() => setStep(2)}>
                    Next
                  </button>
                </div>
              </div>
            ) : null}

            {step === 2 ? (
              <div className="wizard-card">
                <h3>Describe the issue</h3>
                <p className="wizard-subtitle">Choose a category and capture all relevant details.</p>

                <label>Issue Type</label>
                <div className="issue-tabs-row">
                  {ISSUE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`issue-tab ${issueType === option.value ? "active" : ""}`}
                      onClick={() => setIssueType(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                {issueType === "LEAKAGE" ? (
                  <div className="priority-banner">
                    <strong>High priority - Leakage</strong>
                    <span>
                      Advise the customer to close the regulator and ventilate the area immediately.
                    </span>
                  </div>
                ) : null}

                <label>Description *</label>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={5}
                  placeholder="Explain the issue in the customer's words..."
                />

                <div className="flow-actions spread">
                  <button type="button" className="secondary-btn" onClick={() => setStep(1)}>
                    Back
                  </button>
                  <button type="button" className="primary-btn" disabled={!description.trim()} onClick={() => setStep(3)}>
                    Next
                  </button>
                </div>
              </div>
            ) : null}

            {step === 3 ? (
              <div className="wizard-card">
                <h3>Review & confirm</h3>
                <p className="wizard-subtitle">Verify the details before registering this complaint.</p>

                <div className="review-grid">
                  <div>
                    <label>Customer</label>
                    <p>{toText(customerDetails.name) || "-"}</p>
                    <label>Mobile</label>
                    <p>{toText(customerDetails.phone) || "-"}</p>
                  </div>
                  <div>
                    <label>Consumer Number</label>
                    <p>{toText(customerDetails.consumer_number) || "-"}</p>
                    <label>Address</label>
                    <p>{toText(customerDetails.address) || "-"}</p>
                  </div>
                </div>

                <div className="review-tags">
                  <span className={`chip chip-issue ${String(issueType).toLowerCase()}`}>
                    {normalizeIssueLabel(issueType)}
                  </span>
                  <span className="chip chip-status pending">Pending</span>
                </div>

                <label>Description</label>
                <div className="review-description">{description}</div>

                <div className="flow-actions spread">
                  <button type="button" className="secondary-btn" onClick={() => setStep(2)}>
                    Back
                  </button>
                  <button type="button" className="primary-btn" disabled={submitting} onClick={handleRegisterComplaint}>
                    {submitting ? "Registering..." : "Register Complaint"}
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {activeMenu === "New Connection" ? (
          <section className="new-connection-grid">
            <article className="new-connection-form-card">
              <h3>New Connection Form</h3>

              <div className="new-connection-fields two-column">
                <div>
                  <label>Customer Name *</label>
                  <div className="autosuggest-wrap">
                    <input name="customerName" value={newConnectionForm.customerName} onChange={handleConnectionCustomerNameChange} />
                    {activeSuggestionField === "new-connection" && customerNameSuggestions.length ? (
                      <div className="autosuggest-dropdown">
                        {customerNameSuggestions.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className="autosuggest-item"
                            onClick={() => handleSelectSuggestedCustomer("new-connection", item)}
                          >
                            <strong>{item.name || "Customer"}</strong>
                            <span>{item.consumer_number || "-"} • {item.phone || "-"}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div>
                  <label>Mobile Number *</label>
                  <input name="mobileNumber" value={newConnectionForm.mobileNumber} onChange={handleConnectionInputChange} />
                </div>
              </div>

              <div className="new-connection-fields">
                <label>Address</label>
                <input name="address" value={newConnectionForm.address} onChange={handleConnectionInputChange} />
              </div>

              <div className="new-connection-fields">
                <label>ID Proof *</label>
                <label className="upload-field">
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    onChange={handleIdProofUpload}
                    disabled={idProofUploading}
                  />
                  <span>
                    {idProofUploading
                      ? "Uploading..."
                      : newConnectionForm.idProofLabel
                      ? `✓ ${newConnectionForm.idProofLabel}`
                      : "Upload Aadhaar / PAN / Passport / Voter ID"}
                  </span>
                </label>
                {newConnectionForm.idProofUrl ? <p className="upload-success">ID proof uploaded successfully.</p> : null}
              </div>

              <div className="new-connection-fields">
                <label>Product</label>
                <div className="autosuggest-wrap">
                  <input
                    name="productDetails"
                    value={newConnectionForm.productDetails}
                    onChange={(e) => handleProductSearch(e.target.value)}
                    placeholder="Search product by name or type…"
                    autoComplete="off"
                    onFocus={async () => {
                      if (!newConnectionForm.productDetails.trim()) {
                        try {
                          const rows = await searchConnectionProducts("");
                          setProductSuggestions(rows);
                        } catch (_error) {
                          setProductSuggestions([]);
                        }
                      }
                    }}
                    onBlur={() => setTimeout(() => setProductSuggestions([]), 200)}
                  />
                  {productSuggestions.length ? (
                    <div className="autosuggest-dropdown">
                      {productSuggestions.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className="autosuggest-item"
                          onClick={() => handleSelectProduct(item)}
                        >
                          <strong>{item.name}</strong>
                          <span>{item.type} — ₹{Number(item.price || 0).toFixed(2)}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                {newConnectionForm.selectedProducts.length ? (
                  <div className="selected-product-chips">
                    {newConnectionForm.selectedProducts.map((product) => (
                      <span key={product.id} className="selected-product-chip">
                        {product.name}{product.type ? ` (${product.type})` : ""}
                        <button
                          type="button"
                          aria-label={`Remove ${product.name}`}
                          onClick={() => handleRemoveConnectionProduct(product.id)}
                        >
                          X
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="new-connection-fields two-column">
                <div>
                  <label>Deposit Amount (₹)</label>
                  <input name="depositAmount" type="number" min="0" step="0.01" value={newConnectionForm.depositAmount} onChange={handleConnectionInputChange} />
                </div>
                <div>
                  <label>GST Amount (₹)</label>
                  <input name="gstAmount" type="number" min="0" step="0.01" value={newConnectionForm.gstAmount} onChange={handleConnectionInputChange} />
                </div>
              </div>

              <div className="amount-row">
                <label>Final Amount</label>
                <div className="total-payable-box">
                  <span>Total payable</span>
                  <strong>₹ {connectionFinancials.total.toFixed(2)}</strong>
                </div>
              </div>

              <div className="new-connection-actions">
                <button type="button" className="primary-btn" disabled={connectionSubmitting} onClick={handleSendToCashier}>
                  {connectionSubmitting ? "Sending..." : "Send to Cashier"}
                </button>
              </div>
            </article>

            <aside className="recent-applications-card">
              <h4>Recent Applications</h4>
              {recentConnectionsLoading ? <p className="muted">Loading recent connections...</p> : null}
              {!recentConnectionsLoading && !recentConnections.length ? <p className="muted">No recent connections yet.</p> : null}
              <div className="recent-applications-list">
                {recentConnections.map((item) => {
                  const isConnectionPaid =
                    String(item.payment_status || "").toUpperCase() === "PAID";
                  return (
                  <article key={item.id} className="recent-application-row">
                    <div className="recent-row-head">
                      <p>{item.customer_name || item.name || "Customer"}</p>
                      <span className={`payment-chip ${isConnectionPaid ? "approved" : "unpaid"}`}>
                        {isConnectionPaid ? "Approved" : "Pending"}
                      </span>
                    </div>
                    <p className="recent-row-meta recent-row-meta-inline">
                      <span>{item.customer_phone || item.mobile_number || item.phone || "-"}</span>
                      <span>{item.product_details || item.product_name || "Product unavailable"}</span>
                    </p>
                    <p className="recent-row-amount">
                      ₹ {Number(item.total_amount ?? item.total ?? item.deposit_amount ?? 0).toFixed(2)}
                    </p>
                  </article>
                  );
                })}
              </div>
            </aside>
          </section>
        ) : null}

        {activeMenu === "Transfer" ? (
          <section className="transfer-grid">
            <article className="transfer-form-card">
              <h3>Old Customer Details</h3>

              <div className="transfer-fields two-column">
                <div>
                  <label>Consumer Number / Phone *</label>
                  <input name="consumerNumber" value={transferForm.consumerNumber} onChange={handleTransferInputChange} placeholder="e.g. 7598058964 or Phone" />
                </div>
                <div>
                  <label>Existing Name</label>
                  <div className="autosuggest-wrap">
                    <input name="existingName" value={transferForm.existingName} onChange={handleTransferExistingNameChange} placeholder="Type existing customer name" />
                    {activeSuggestionField === "transfer-existing" && customerNameSuggestions.length ? (
                      <div className="autosuggest-dropdown">
                        {customerNameSuggestions.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className="autosuggest-item"
                            onClick={() => handleSelectSuggestedCustomer("transfer-existing", item)}
                          >
                            <strong>{item.name || "Customer"}</strong>
                            <span>{item.consumer_number || "-"} • {item.phone || "-"}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              {transferLookupLoading ? <p className="muted">Loading existing customer details...</p> : null}

              <h3>New Customer Details</h3>

              <div className="transfer-fields two-column">
                <div>
                  <label>New Customer Name *</label>
                  <div className="autosuggest-wrap">
                    <input name="newCustomerName" value={transferForm.newCustomerName} onChange={handleTransferNewCustomerNameChange} />
                    {activeSuggestionField === "transfer-new" && customerNameSuggestions.length ? (
                      <div className="autosuggest-dropdown">
                        {customerNameSuggestions.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className="autosuggest-item"
                            onClick={() => handleSelectSuggestedCustomer("transfer-new", item)}
                          >
                            <strong>{item.name || "Customer"}</strong>
                            <span>{item.consumer_number || "-"} • {item.phone || "-"}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div>
                  <label>Mobile</label>
                  <input name="newCustomerMobile" value={transferForm.newCustomerMobile} onChange={handleTransferInputChange} />
                </div>
              </div>

              <div className="transfer-fields">
                <label>Address</label>
                <input name="newCustomerAddress" value={transferForm.newCustomerAddress} onChange={handleTransferInputChange} />
              </div>

              <div className="transfer-fields">
                <label>Deposit / Liability (₹)</label>
                <input name="depositLiability" type="number" min="0" step="0.01" value={transferForm.depositLiability} onChange={handleTransferInputChange} />
              </div>

              <div className="transfer-fields">
                <label>Reason for Transfer *</label>
                <textarea name="reason" value={transferForm.reason} onChange={handleTransferInputChange} rows={3} />
              </div>

              <div className="transfer-fields">
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    name="isRegulatorReceived"
                    checked={transferForm.isRegulatorReceived}
                    onChange={(event) =>
                      setTransferForm((previous) => ({ ...previous, isRegulatorReceived: event.target.checked }))
                    }
                  />
                  <span>Regulator received</span>
                </label>
              </div>

              <div className="transfer-actions">
                <button type="button" className="primary-btn" disabled={transferSubmitting} onClick={handleSendTransferRequest}>
                  {transferSubmitting ? "Sending..." : "Send to Manager & Cashier"}
                </button>
              </div>
            </article>

            <aside className="recent-transfers-card">
              <h4>Recent Transfers</h4>
              {recentTransfersLoading ? <p className="muted">Loading transfers...</p> : null}
              {!recentTransfersLoading && !recentTransfers.length ? <p className="muted">No recent transfers yet.</p> : null}
              <div className="recent-transfers-list">
                {recentTransfers.map((item) => (
                  <article key={item.id} className="recent-transfer-row">
                    <div className="recent-row-head">
                      <p>{item.existing_customer_name || item.existing_name || "Customer"} → {item.new_customer_name || item.new_name || "New Customer"}</p>
                      <span className={`payment-chip ${String(item.status || "PENDING_MANAGER").toLowerCase().replaceAll(" ", "-")}`}>
                        {String(item.status || "PENDING_MANAGER")
                          .replace(/_/g, " ")
                          .split(" ")
                          .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                          .join(" ")}
                      </span>
                    </div>
                    <p className="recent-row-meta">{item.reason || "-"}</p>
                  </article>
                ))}
              </div>
            </aside>
          </section>
        ) : null}

        {activeMenu === "Name Change" ? (
          <section className="name-change-grid">
            <article className="name-change-form-card">
              <div className="name-change-fields two-column">
                <div>
                  <label>Consumer Number / Phone *</label>
                  <input name="consumerNumber" value={nameChangeForm.consumerNumber} onChange={handleNameChangeInputChange} placeholder="e.g. 7598058964 or Phone" />
                </div>
                <div>
                  <label>Service Fee (₹)</label>
                  <input name="serviceFee" type="number" min="0" step="0.01" value={nameChangeForm.serviceFee} onChange={handleNameChangeInputChange} />
                </div>
              </div>

              <div className="name-change-fields two-column">
                <div>
                  <label>Existing Name</label>
                  <div className="autosuggest-wrap">
                    <input name="existingName" value={nameChangeForm.existingName} onChange={handleNameChangeExistingNameChange} placeholder="Type existing name" />
                    {activeSuggestionField === "name-change-existing" && customerNameSuggestions.length ? (
                      <div className="autosuggest-dropdown">
                        {customerNameSuggestions.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className="autosuggest-item"
                            onClick={() => handleSelectSuggestedCustomer("name-change-existing", item)}
                          >
                            <strong>{item.name || "Customer"}</strong>
                            <span>{item.consumer_number || "-"} • {item.phone || "-"}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div>
                  <label>New Name *</label>
                  <input name="newName" value={nameChangeForm.newName} onChange={handleNameChangeInputChange} placeholder="Enter new name" />
                </div>
              </div>

              {nameChangeLookupLoading ? <p className="muted">Loading customer details...</p> : null}

              <div className="name-change-fields">
                <label>Supporting Document *</label>
                <label className="upload-field">
                  <input type="file" accept="image/*,application/pdf" onChange={handleNameChangeDocumentUpload} />
                  <span>{nameChangeForm.documentLabel ? `Selected file: ${nameChangeForm.documentLabel}` : "Upload affidavit / marriage certificate / gazette"}</span>
                </label>
                {nameChangeForm.documentUrl ? <p className="upload-success">Document uploaded successfully.</p> : null}
              </div>

              <div className="name-change-actions">
                <button type="button" className="primary-btn" disabled={nameChangeSubmitting} onClick={handleCreateNameChangeRequest}>
                  {nameChangeSubmitting ? "Creating..." : "Create Request"}
                </button>
              </div>
            </article>

            <aside className="recent-name-changes-card">
              <h4>Recent Requests</h4>
              {recentNameChangesLoading ? <p className="muted">Loading requests...</p> : null}
              {!recentNameChangesLoading && !recentNameChanges.length ? <p className="muted">No name change requests yet.</p> : null}
              <div className="recent-name-changes-list">
                {recentNameChanges.map((item) => (
                  <article key={item.id} className="recent-name-change-row">
                    <div className="recent-row-head">
                      <p>{item.existing_name || "Customer"} → {item.new_name_requested || item.new_name || "New Name"}</p>
                      <span className={`payment-chip ${(item.approval_status || "PENDING").toLowerCase()}`}>
                        {item.approval_status === "APPROVED" ? "Approved" : item.approval_status === "REJECTED" ? "Rejected" : "Pending"}
                      </span>
                    </div>
                    <p className="recent-row-meta">{item.consumer_number || "-"} • ₹ {Number(item.service_fee || 0).toFixed(2)}</p>
                    {item.document_url ? <p className="recent-row-meta">Document uploaded</p> : null}
                  </article>
                ))}
              </div>
            </aside>
          </section>
        ) : null}

        {activeMenu === "PR Penalty" ? (
          <section className="pr-penalty-grid">
            <article className="pr-penalty-form-card">
              <div className="pr-penalty-fields two-column">
                <div>
                  <label>Consumer Number / Phone *</label>
                  <input
                    name="consumerNumber"
                    value={prPenaltyForm.consumerNumber}
                    onChange={handlePrPenaltyInputChange}
                    placeholder="e.g. 751008428 or Phone"
                  />
                </div>
                <div>
                  <label>Customer Name *</label>
                  <div className="autosuggest-wrap">
                    <input
                      name="customerName"
                      value={prPenaltyForm.customerName}
                      onChange={handlePrPenaltyCustomerNameChange}
                      placeholder="Enter customer name"
                    />
                    {activeSuggestionField === "pr-penalty" && customerNameSuggestions.length ? (
                      <div className="autosuggest-dropdown">
                        {customerNameSuggestions.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className="autosuggest-item"
                            onClick={() => handleSelectSuggestedCustomer("pr-penalty", item)}
                          >
                            <strong>{item.name || "Customer"}</strong>
                            <span>{item.consumer_number || "-"} • {item.phone || "-"}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              {prPenaltyLookupLoading ? <p className="muted">Looking up customer...</p> : null}

              <div className="pr-penalty-fields">
                <label>Penalty Reason *</label>
                <input
                  name="penaltyReason"
                  value={prPenaltyForm.penaltyReason}
                  onChange={handlePrPenaltyInputChange}
                  placeholder="Enter penalty reason"
                />
              </div>

              <div className="pr-penalty-fields pr-penalty-amount-row">
                <div>
                  <label>Penalty Amount (₹)</label>
                  <input
                    name="penaltyAmount"
                    type="number"
                    min="0"
                    step="0.01"
                    value={prPenaltyForm.penaltyAmount}
                    onChange={handlePrPenaltyInputChange}
                  />
                </div>
              </div>

              <div className="pr-penalty-actions">
                <button
                  type="button"
                  className="primary-btn"
                  disabled={prPenaltySubmitting}
                  onClick={handleRecordPenalty}
                >
                  {prPenaltySubmitting ? "Recording..." : "Record Penalty"}
                </button>
              </div>
            </article>

            <aside className="pr-penalty-list-card">
              <h4>Penalties</h4>
              {recentPenaltiesLoading ? <p className="muted">Loading penalties...</p> : null}
              {!recentPenaltiesLoading && !recentPenalties.length ? (
                <p className="muted">No penalties yet.</p>
              ) : null}

              <div className="pr-penalty-list">
                {recentPenalties.map((item) => {
                  const isPaid = String(item.payment_status || "UNPAID").toUpperCase() === "PAID";
                  return (
                    <article key={item.id} className="pr-penalty-row">
                      <div className="recent-row-head">
                        <p>{item.customer_name || "Customer"}</p>
                        <span className={`payment-chip ${isPaid ? "paid" : "unpaid"}`}>
                          {isPaid ? "Paid" : "Unpaid"}
                        </span>
                      </div>

                      <p className="recent-row-meta">
                        {item.consumer_number || "-"} · {item.penalty_reason || "-"}
                      </p>

                      <div className="pr-penalty-row-footer">
                        <p className="recent-row-amount">₹ {Number(item.penalty_amount || 0).toFixed(0)}</p>
                        {!isPaid ? (
                          <button
                            type="button"
                            className="secondary-btn pr-penalty-mark-btn"
                            onClick={() => handleMarkPenaltyPaid(item.id)}
                          >
                            Mark Paid
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </aside>
          </section>
        ) : null}



        {activeMenu === "IOC OTPs" ? (
          <section className="ioc-otp-section">
            {showAddOtpForm ? (
              <div className="ioc-add-form">
                <div>
                  <label>Sale ID</label>
                  <input
                    value={addOtpSaleId}
                    onChange={(event) => setAddOtpSaleId(event.target.value)}
                    placeholder="Enter sale id"
                  />
                </div>
                <div>
                  <label>OTP</label>
                  <input
                    value={addOtpValue}
                    onChange={(event) => setAddOtpValue(event.target.value)}
                    placeholder="Enter OTP"
                  />
                </div>
                <div className="ioc-add-form-actions">
                  <button type="button" className="secondary-btn" onClick={() => setShowAddOtpForm(false)}>
                    Cancel
                  </button>
                  <button type="button" className="primary-btn" onClick={handleAddIocOtp} disabled={addOtpSubmitting}>
                    {addOtpSubmitting ? "Adding..." : "Save OTP"}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="ioc-cards-grid">
              <article className="ioc-card received">
                <p>Today - Received</p>
                <strong>{iocOtpSummary.todayReceived}</strong>
              </article>
              <article className="ioc-card pending">
                <p>Today - Pending</p>
                <strong>{iocOtpSummary.todayPending}</strong>
              </article>
              <article className="ioc-card sent">
                <p>Today - Sent to IOC</p>
                <strong>{iocOtpSummary.todaySent}</strong>
              </article>
              <article className="ioc-card allpending">
                <p>All Pending</p>
                <strong>{iocOtpSummary.allPending}</strong>
              </article>
            </div>

            <div className="ioc-list-card">
              <div className="ioc-list-topbar">
                <div className="ioc-tabs">
                  <button
                    type="button"
                    className={`ioc-tab ${iocOtpTab === "PENDING" ? "active" : ""}`}
                    onClick={() => handleIocOtpTabChange("PENDING")}
                  >
                    Pending
                  </button>
                  <button
                    type="button"
                    className={`ioc-tab ${iocOtpTab === "SENT" ? "active" : ""}`}
                    onClick={() => handleIocOtpTabChange("SENT")}
                  >
                    Sent
                  </button>
                  <button
                    type="button"
                    className={`ioc-tab ${iocOtpTab === "ALL" ? "active" : ""}`}
                    onClick={() => handleIocOtpTabChange("ALL")}
                  >
                    All
                  </button>
                </div>

                <div className="ioc-filters">
                  <input type="date" value={iocOtpDate} onChange={(event) => setIocOtpDate(event.target.value)} />
                  <select value={iocOtpDriverFilter} onChange={(event) => setIocOtpDriverFilter(event.target.value)}>
                    <option value="ALL">All drivers</option>
                    {iocDriverOptions.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="primary-btn"
                    onClick={handleDownloadIocOtpsSheet}
                    title="Download IOC OTPs as CSV"
                  >
                    ↓ Download Sheet
                  </button>
                </div>
              </div>

              <div className="ioc-table-wrap">
                <table className="ioc-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Driver</th>
                      <th>Customer</th>
                      <th>Consumer #</th>
                      <th>OTP</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {iocOtpsLoading ? (
                      <tr>
                        <td colSpan={7}>Loading OTPs...</td>
                      </tr>
                    ) : null}

                    {!iocOtpsLoading && !iocOtps.length ? (
                      <tr>
                        <td colSpan={7}>No OTPs found.</td>
                      </tr>
                    ) : null}

                    {!iocOtpsLoading
                      ? iocOtps.map((item) => {
                          const isPending = String(item.status || "PENDING").toUpperCase() === "PENDING";
                          return (
                            <tr key={item.id}>
                              <td>{item.created_at_formatted}</td>
                              <td>{item.driver_name || "-"}</td>
                              <td>{item.customer_name || "-"}</td>
                              <td>{item.consumer_number || "-"}</td>
                              <td>
                                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                                  <strong>{item.otp}</strong>
                                  <button
                                    type="button"
                                    title="Copy OTP"
                                    className="ioc-copy-btn"
                                    onClick={() => handleCopyOtp(item.otp)}
                                  >
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                      <rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect>
                                      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
                                    </svg>
                                    <span>Copy</span>
                                  </button>
                                </div>
                              </td>
                              <td>
                                <span className={`payment-chip ${isPending ? "unpaid" : "paid"}`}>
                                  {isPending ? "Pending" : "Sent"}
                                </span>
                              </td>
                              <td>
                                {isPending ? (
                                  <button
                                    type="button"
                                    className="secondary-btn ioc-sent-btn"
                                    onClick={() => handleMarkOtpSent(item.id)}
                                  >
                                    Sent
                                  </button>
                                ) : (
                                  <span className="muted">Done</span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      : null}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        ) : null}

        {activeMenu === "Customers" ? (
          <section className="customers-dashboard-grid">
            <aside className="customers-directory-card">
              <div className="customers-directory-head">
                <h4>Customers</h4>
                <button type="button" className="secondary-btn" onClick={handleClearCustomerSelection}>
                  Clear
                </button>
              </div>

              <input
                className="customers-search-input"
                value={customerDirectorySearch}
                onChange={(event) => setCustomerDirectorySearch(event.target.value)}
                placeholder="Search customer by name, mobile or consumer #"
              />

              {customerDirectoryLoading ? <p className="muted">Loading customers...</p> : null}

              <div className="customers-directory-list">
                {!customerDirectoryLoading && !customerDirectory.length ? <p className="muted">No customers found.</p> : null}

                {customerDirectory.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`customers-directory-item ${Number(selectedDashboardCustomerId) === Number(item.id) ? "active" : ""}`}
                    onClick={() => setSelectedDashboardCustomerId(Number(item.id))}
                  >
                    <p className="customers-directory-name">{item.name || "Customer"}</p>
                    <p className="customers-directory-meta">{item.consumer_number || "-"}</p>
                    <p className="customers-directory-meta">{item.phone || "-"}</p>
                  </button>
                ))}
              </div>
            </aside>

            <section className="customers-details-card">
              {!selectedDashboardCustomerId ? (
                <p className="muted">Select a customer from the left list to view details.</p>
              ) : null}

              {customerDashboardLoading ? <p className="muted">Loading customer details...</p> : null}

              {customerDashboardDetails && !customerDashboardLoading ? (
                <>
                  <article className="customer-profile-panel">
                    <h3>Customer Details</h3>
                    <div className="customer-profile-grid">
                      <div>
                        <label>Name</label>
                        <p>{customerDashboardDetails.profile?.name || "-"}</p>
                      </div>
                      <div>
                        <label>Consumer Number</label>
                        <p>{customerDashboardDetails.profile?.consumer_number || "-"}</p>
                      </div>
                      <div>
                        <label>Phone</label>
                        <p>{customerDashboardDetails.profile?.phone || "-"}</p>
                      </div>
                      <div>
                        <label>Address</label>
                        <p>{customerDashboardDetails.profile?.address || "-"}</p>
                      </div>
                    </div>
                  </article>

                  <article className="customer-history-panel">
                    <h4>Complaint History</h4>
                    <div className="customer-history-table-wrap">
                      <table className="customer-history-table">
                        <thead>
                          <tr>
                            <th>Issue</th>
                            <th>Description</th>
                            <th>Status</th>
                            <th>Created</th>
                          </tr>
                        </thead>
                        <tbody>
                          {!customerDashboardDetails.complaintHistory?.length ? (
                            <tr>
                              <td colSpan={4}>No complaints found.</td>
                            </tr>
                          ) : (
                            customerDashboardDetails.complaintHistory.map((item) => (
                              <tr key={item.id}>
                                <td>{item.issueType || "-"}</td>
                                <td>{item.description || "-"}</td>
                                <td>{item.status || "-"}</td>
                                <td>{getDaysAgo(item.createdAt)}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </article>

                  <article className="customer-history-panel">
                    <h4>Request History</h4>
                    <div className="customer-history-table-wrap">
                      <table className="customer-history-table">
                        <thead>
                          <tr>
                            <th>Request</th>
                            <th>Description</th>
                            <th>Status</th>
                            <th>Created</th>
                          </tr>
                        </thead>
                        <tbody>
                          {!customerDashboardDetails.requestHistory?.length ? (
                            <tr>
                              <td colSpan={4}>No requests found.</td>
                            </tr>
                          ) : (
                            customerDashboardDetails.requestHistory.map((item) => (
                              <tr key={item.id}>
                                <td>{item.title || "-"}</td>
                                <td>{item.description || "-"}</td>
                                <td>{item.status || "-"}</td>
                                <td>{getDaysAgo(item.createdAt)}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </article>

                  <article className="customer-history-panel">
                    <h4>Payment Status</h4>
                    <div className="customer-history-table-wrap">
                      <table className="customer-history-table">
                        <thead>
                          <tr>
                            <th>Penalty Reason</th>
                            <th>Amount</th>
                            <th>Status</th>
                            <th>Created</th>
                          </tr>
                        </thead>
                        <tbody>
                          {!customerDashboardDetails.paymentStatus?.length ? (
                            <tr>
                              <td colSpan={4}>No payment records found.</td>
                            </tr>
                          ) : (
                            customerDashboardDetails.paymentStatus.map((item) => (
                              <tr key={item.id}>
                                <td>{item.reason || "-"}</td>
                                <td>₹ {Number(item.amount || 0).toFixed(2)}</td>
                                <td>{item.status || "-"}</td>
                                <td>{getDaysAgo(item.createdAt)}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </article>
                </>
              ) : null}
            </section>
          </section>
        ) : null}

        {activeMenu !== "Dashboard" && activeMenu !== "Complaints" && activeMenu !== "New Connection" && activeMenu !== "Transfer" && activeMenu !== "Name Change" && activeMenu !== "PR Penalty" && activeMenu !== "IOC OTPs" && activeMenu !== "Customers" ? (
          <section className="panel placeholder-panel">
            <p className="muted">{activeMenu} module will be connected next.</p>
          </section>
        ) : null}
      </main>
    </div>
  );
}

const readStoredUser = () => {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_error) {
    return null;
  }
};

function App() {
  const [authUser, setAuthUser] = useState(() =>
    localStorage.getItem(AUTH_TOKEN_KEY) ? readStoredUser() : null
  );

  const handleLoggedIn = (token, user) => {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
    setAuthUser(user);
  };

  const handleSignOut = () => {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    setAuthUser(null);
  };

  if (!authUser) {
    return <Login onLoggedIn={handleLoggedIn} />;
  }

  return <Dashboard onSignOut={handleSignOut} />;
}

export default App;
