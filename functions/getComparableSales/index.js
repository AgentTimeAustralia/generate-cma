//Comparable Sales Button Widget

"use strict";

require("dotenv").config();
// adding what s recomeneded

const catalyst = require("zcatalyst-sdk-node");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

module.exports = async (req, res) => {
  const catalystApp = catalyst.initialize(req);

  const datastore = catalystApp.datastore();

  const usageTable = datastore.table("WidgetUsageLogs");
  const creditsTable = datastore.table("CreditsBalance");
  const htagConsumptionTable = datastore.table("HTAGConsumptionLogs");
  const zcql = catalystApp.zcql();

  // =============================================
  // CORS
  // =============================================

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-org-id, x-crm-user, x-record-id"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(200);

    res.end();

    return;
  }

  let body = {};
  const startTime = Date.now();

  let usageBreakdown = [];

  let totalBillingUnits = 0;

  let totalBillingCost = 0;

  let currentBillingBalance = null;

  let creditRow = null;

  let tenantRow = null;

  let newBalance = 0;

  try {
    // =============================================
    // AUTHENTICATION CHECK
    // =============================================

    const currentUser = await catalystApp.userManagement().getCurrentUser();

    // console.log("AUTHENTICATED USER:", currentUser);

    if (!currentUser || !currentUser.user_id) {
      res.writeHead(401, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          success: false,
          message: "Unauthorized",
        })
      );

      return;
    }

    // =============================================
    // ORG DETAILS
    // =============================================
    // removing white space from org id id exist.
    const orgId = String(req.headers["x-org-id"] || "").trim();
    // console.log("ORG ID HEADER:", orgId);

    // const crmUser = req.headers["x-crm-user"] || "Unknown User";
    // =============================================
    // FETCH CREDIT BALANCE
    // =============================================

    const creditResult = await zcql.executeZCQLQuery(
      `SELECT * FROM CreditsBalance WHERE OrgID='${orgId}'`
    );

    // console.log("CREDIT RESULT:", JSON.stringify(creditResult, null, 2));

    const apiTenantResult = await zcql.executeZCQLQuery(
      `SELECT * FROM apiTenants WHERE Org_ID='${orgId}'`
    );

    const paymentHistoryResult = await zcql.executeZCQLQuery(
      `SELECT * FROM PaymentHistory
       WHERE OrgID='${orgId}'
       ORDER BY LastTopupDate DESC`
    );

    let lastTopupDate = "";
    let lastTopup = 0;
    let totalCreditsPurchased = 0;
    let latestPayment = null;

    if (paymentHistoryResult && paymentHistoryResult.length > 0) {
      paymentHistoryResult.forEach((row) => {
        totalCreditsPurchased += Number(row.PaymentHistory.CreditToppedUp || 0);

        if (
          !latestPayment ||
          new Date(row.PaymentHistory.LastTopupDate) >
            new Date(latestPayment.LastTopupDate)
        ) {
          latestPayment = row.PaymentHistory;
        }
      });

      if (latestPayment) {
        lastTopupDate = latestPayment.LastTopupDate || "";
        lastTopup = Number(latestPayment.CreditToppedUp || 0);
      }
    }

    // console.log("LAST TOPUP:", lastTopup);
    // console.log("LAST TOPUP DATE:", lastTopupDate);
    // console.log("TOTAL PURCHASED:", totalCreditsPurchased);

    // console.log(
    //   "PAYMENT HISTORY RESULT:",
    //   JSON.stringify(paymentHistoryResult, null, 2)
    // );

    // console.log("API TENANT RESULT:", JSON.stringify(apiTenantResult, null, 2));

    if (apiTenantResult && apiTenantResult.length > 0) {
      tenantRow = apiTenantResult[0].apiTenants;
    }

    let currentCredits = Number(tenantRow?.CreditsLeft || 0);

    let latestPaymentGlobal = latestPayment;

    // =============================================
    // PAYMENT HISTORY TOPUP SYNC
    // =============================================

    if (
      apiTenantResult &&
      apiTenantResult.length > 0 &&
      paymentHistoryResult &&
      paymentHistoryResult.length > 0
    ) {
      tenantRow = apiTenantResult[0].apiTenants;

      const latestPayment = latestPaymentGlobal;

      // console.log(
      //   "LATEST PAYMENT ROW:",
      //   JSON.stringify(latestPayment, null, 2)
      // );

      // console.log("PAYMENT CREDIT:", latestPayment.CreditToppedUp);

      // console.log("PAYMENT DATE:", latestPayment.LastTopupDate);

      // console.log("TENANT LAST TOPUP:", tenantRow.LastTopUpDate);

      // console.log("TENANT CURRENT CREDITS:", tenantRow.CreditsLeft);

      const tenantLastTopup = tenantRow.LastTopUpDate
        ? new Date(tenantRow.LastTopUpDate)
        : null;

      const paymentLastTopup = latestPayment.LastTopupDate
        ? new Date(latestPayment.LastTopupDate)
        : null;

      if (
        !tenantLastTopup ||
        paymentLastTopup > tenantLastTopup ||
        Number(tenantRow.CreditsLeft || 0) <= 0
      ) {
        // console.log("NEW TOPUP DETECTED");

        const topupCredits = Number(latestPayment.CreditToppedUp || 0);

        const newCredits = topupCredits;

        // console.log("UPDATING APITENANTS =>", {
        //   creditsBefore: currentCredits,
        //   topupCredits,
        //   creditsAfter: newCredits,
        //   lastTopUpDate: latestPayment.LastTopupDate,
        // });

        await zcql.executeZCQLQuery(`
          UPDATE apiTenants
SET CreditsLeft=${newCredits},
    CreditStatus='Active',
    LastTopUpDate='${latestPayment.LastTopupDate}',
    SubscriptionPlan='${latestPayment.SubscriptionPlan}',
    SubscriptionStatus='${latestPayment.SubscriptionStatus}',
    SubscriptionExpiryDate='${latestPayment.SubscriptionExpiryDate}'
          WHERE ROWID='${tenantRow.ROWID}'
          `);

        const refreshedTenant = await zcql.executeZCQLQuery(
          `SELECT * FROM apiTenants WHERE ROWID='${tenantRow.ROWID}'`
        );

        tenantRow = refreshedTenant[0].apiTenants;
        currentCredits = Number(tenantRow.CreditsLeft || 0);

        // console.log("TOPUP APPLIED:", topupCredits, "NEW BALANCE:", newCredits);
      }
    }

    if (!tenantRow) {
      throw new Error("No apiTenants record found for Org ID: " + orgId);
    }

    // =============================================
    // SUBSCRIPTION VALIDATION
    // =============================================

    const subscriptionStatus = tenantRow.SubscriptionStatus || "Expired";

    const subscriptionExpiryDate = tenantRow.SubscriptionExpiryDate
      ? new Date(tenantRow.SubscriptionExpiryDate)
      : null;

    const today = new Date();

    today.setHours(0, 0, 0, 0);

    if (subscriptionExpiryDate) {
      subscriptionExpiryDate.setHours(0, 0, 0, 0);
    }

    if (
      subscriptionStatus !== "Active" ||
      !subscriptionExpiryDate ||
      subscriptionExpiryDate < today
    ) {
      res.statusCode = 403;

      res.setHeader("Content-Type", "application/json");

      return res.end(
        JSON.stringify({
          success: false,
          error: "subscription_expired",
          message:
            "Your HtAG subscription has expired. Please renew your subscription.",
        })
      );
    }

    const MIN_REQUIRED_CREDITS = 20;

    if (currentCredits < MIN_REQUIRED_CREDITS) {
      try {
        await usageTable.insertRow({
          Org_ID: orgId,

          CRM_User: req.headers["x-crm-user"] || "Unknown User",

          Function_Name: "getComparableSales",

          Feature_Name: "Comparable Sales",

          Record_ID: req.headers["x-record-id"] || "Unknown Record",

          Execution_Time_MS: 0,

          Status: "insufficient_credits",

          API_Consumption: 0,

          Usage_Response: `Available Credits=${currentCredits}, Required Credits=${MIN_REQUIRED_CREDITS}`,
        });
      } catch (logError) {
        console.error("INSUFFICIENT CREDIT LOG ERROR", logError);
      }

      res.writeHead(402, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          error: "insufficient_credits",

          message: `Oops! Low credits left. Minimum ${MIN_REQUIRED_CREDITS} credits required to run Comparable Sales.`,

          available_credits: currentCredits,

          required_credits: MIN_REQUIRED_CREDITS,
        })
      );

      return;
    }

    // ============================================
    // GET ADDRESS FROM QUERY PARAMS
    // ============================================

    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);

    const address = url.searchParams.get("address");
    const existingAddressKey = url.searchParams.get("address_key");
    const priceRange = url.searchParams.get("priceRange") || "";
    const bedrooms = url.searchParams.get("bedrooms") || "";
    const bathrooms = url.searchParams.get("bathrooms") || "";
    const limit = Number(url.searchParams.get("limit")) || 5;
    const radius = Math.min(Number(url.searchParams.get("radius")) || 2, 5);

    if (!address) {
      res.writeHead(400, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          error: "missing_address",
          message: "Address is required.",
        })
      );

      return;
    }

    // ============================================
    // GET API KEY
    // ============================================

    const apiKey = process.env.HTAG_API_KEY;

    if (!apiKey) {
      res.writeHead(500, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          error: "missing_api_key",
          message: "HTAG API key missing.",
        })
      );

      return;
    }

    // ============================================
    // STEP 1 - ADDRESS KEY RESOLUTION
    // ============================================

    let addressKey = existingAddressKey || "";

    // console.log("EXISTING ADDRESS KEY:", addressKey);

    // ============================================
    // FALLBACK TO STANDARDISATION
    // ============================================

    if (!addressKey) {
      // console.log("NO ADDRESS KEY FOUND. STANDARDISING:", address);

      const standardiseResponse = await fetch(
        "https://api.htagai.com/v1/address/standardise",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            addresses: [address],
          }),
        }
      );

      const standardiseData = await standardiseResponse.json();

      // ============================================
      // BILLING TRACKING
      // ============================================

      totalBillingUnits += Number(
        standardiseResponse.headers.get("x-billing-units") || 0
      );

      usageBreakdown.push(
        `address/standardise = ${
          standardiseResponse.headers.get("x-billing-units") || 0
        } units`
      );

      totalBillingCost += Number(
        standardiseResponse.headers.get("x-billing-cost") || 0
      );

      usageBreakdown.push(
        `address/standardise = ${
          standardiseResponse.headers.get("x-billing-cost") || 0
        } cost`
      );

      currentBillingBalance =
        standardiseResponse.headers.get("x-billing-balance") ||
        currentBillingBalance;

      // console.log(
      //   "HTAG STANDARDISE RESPONSE:",
      //   JSON.stringify(standardiseData, null, 2)
      // );

      // ============================================
      // HANDLE CREDIT LIMIT
      // ============================================

      if (standardiseResponse.status === 402) {
        res.writeHead(402, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            error: "payment_required",
            message:
              "Oops! You have exhausted credits. Please top-up and try again.",
          })
        );

        return;
      }

      // ============================================
      // HANDLE STANDARDISATION FAILURE
      // ============================================

      if (
        !standardiseData.results ||
        standardiseData.results.length === 0 ||
        !standardiseData.results[0].address_key
      ) {
        res.writeHead(404, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            error: "address_standardisation_failed",
            message: "Could not standardise address.",
            input_address: address,
            response: standardiseData,
          })
        );

        return;
      }

      // ============================================
      // EXTRACT GENERATED ADDRESS KEY
      // ============================================

      addressKey = standardiseData.results[0].address_key;
    }

    // console.log("FINAL ADDRESS KEY:", addressKey);

    // ============================================
    // STEP 2 - SOLD SEARCH USING ADDRESS KEY
    // ============================================

    let soldSearchUrl =
      `https://api.htagai.com/v1/property/sold/search?` +
      `address_key=${encodeURIComponent(addressKey)}` +
      `&radius=${radius * 1000}` +
      `&proximity=any` +
      `&limit=${limit}`;

    // ============================================
    // PRICE RANGE FILTER
    // ============================================

    if (priceRange) {
      const [minPrice, maxPrice] = priceRange.split("-").map(Number);

      if (!isNaN(minPrice) && !isNaN(maxPrice)) {
        if (minPrice > 0) {
          soldSearchUrl += `&saleValueMin=${minPrice}`;
        }

        if (maxPrice < 999999999) {
          soldSearchUrl += `&saleValueMax=${maxPrice}`;
        }
      }
    }
    // ============================================
    // BEDROOM FILTER
    // ============================================

    if (bedrooms) {
      const bedroomCount = Number(bedrooms);

      if (Number.isInteger(bedroomCount) && bedroomCount > 0) {
        soldSearchUrl += `&bedrooms_min=${bedroomCount}`;
        soldSearchUrl += `&bedrooms_max=${bedroomCount}`;
      }
    }

    // ============================================
    // BATHROOM FILTER
    // ============================================

    if (bathrooms) {
      const bathroomCount = Number(bathrooms);

      if (Number.isInteger(bathroomCount) && bathroomCount > 0) {
        soldSearchUrl += `&bathrooms_min=${bathroomCount}`;
        soldSearchUrl += `&bathrooms_max=${bathroomCount}`;
      }
    }
    console.log("============================================");
    console.log("HTAG SOLD SEARCH REQUEST");
    console.log("============================================");
    console.log("ADDRESS:", address);
    console.log("ADDRESS KEY:", addressKey);
    console.log("PRICE RANGE:", priceRange || "All Prices");
    console.log("BEDROOMS:", bedrooms || "Any");
    console.log("BATHROOMS:", bathrooms || "Any");
    console.log("RADIUS:", radius, "km");
    console.log("RESULT LIMIT:", limit);
    console.log("HTAG SOLD SEARCH URL:", soldSearchUrl);
    console.log("============================================");

    const soldResponse = await fetch(soldSearchUrl, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
      },
    });

    const requestId = soldResponse.headers.get("x-amzn-requestid") || "";

    // console.log("REQUEST ID:", requestId);

    const soldData = await soldResponse.json();

    console.log("============================================");
    console.log("HTAG SOLD SEARCH RESPONSE");
    console.log("STATUS:", soldResponse.status);
    console.log("OK:", soldResponse.ok);
    console.log("TOTAL RESULTS:", soldData?.total || 0);
    console.log("RETURNED RESULTS:", soldData?.results?.length || 0);
    console.log("HTAG RESPONSE:", JSON.stringify(soldData, null, 2));
    console.log("============================================");

    // ============================================
    // BILLING TRACKING
    // ============================================

    totalBillingUnits += Number(
      soldResponse.headers.get("x-billing-units") || 0
    );

    usageBreakdown.push(
      `property/sold/search = ${
        soldResponse.headers.get("x-billing-units") || 0
      } units`
    );

    totalBillingCost += Number(soldResponse.headers.get("x-billing-cost") || 0);

    usageBreakdown.push(
      `property/sold/search = ${
        soldResponse.headers.get("x-billing-cost") || 0
      } cost`
    );

    currentBillingBalance =
      soldResponse.headers.get("x-billing-balance") || currentBillingBalance;

    // ============================================
    // UPDATE CREDIT BALANCE
    // ============================================

    try {
      if (!creditResult || creditResult.length === 0) {
        // console.log(
        //   "NO CREDITS BALANCE RECORD FOUND. CREATING ONE..."
        // );

        const newCreditRow = await creditsTable.insertRow({
          OrgID: orgId,

          CreditsRemaining: Number(tenantRow?.CreditsLeft || 0),

          Total_Credits_Purchased: totalCreditsPurchased,

          Last_Credits_Consumed: 0,

          LastCreditUsageDate: new Date()
            .toISOString()
            .slice(0, 19)
            .replace("T", " "),
        });

        creditRow = newCreditRow;
      } else {
        creditRow = creditResult[0].CreditsBalance;
      }

      if (!apiTenantResult || apiTenantResult.length === 0) {
        throw new Error("No apiTenants record found for Org ID: " + orgId);
      }

      if (!tenantRow) {
        tenantRow = apiTenantResult[0].apiTenants;
      }

      if (!tenantRow) {
        throw new Error("No apiTenants record found for Org ID: " + orgId);
      }

      if (
        Number(creditRow.CreditsRemaining || 0) === 0 &&
        Number(tenantRow.CreditsLeft || 0) > 0
      ) {
        await creditsTable.updateRow({
          ROWID: creditRow.ROWID,
          CreditsRemaining: tenantRow.CreditsLeft,
          Total_Credits_Purchased: totalCreditsPurchased,
        });

        creditRow.CreditsRemaining = tenantRow.CreditsLeft;
        currentCredits = Number(tenantRow.CreditsLeft);
      }
      // console.log("CURRENT CREDITS BEFORE CHECK:", currentCredits);

      newBalance = Math.max(0, currentCredits - totalBillingUnits);

      // console.log(
      //   "CREDIT DEDUCTION:",
      //   currentCredits,
      //   "-",
      //   totalBillingUnits,
      //   "=",
      //   newBalance
      // );

      // console.log("FINAL TOTAL PURCHASED:", totalCreditsPurchased);

      await creditsTable.updateRow({
        ROWID: creditRow.ROWID,
        CreditsRemaining: newBalance,
        Total_Credits_Purchased: totalCreditsPurchased,
        Last_Credits_Consumed: totalBillingUnits,
        LastCreditUsageDate: new Date()
          .toISOString()
          .slice(0, 19)
          .replace("T", " "),
      });

      // console.log("UPDATING CREDITS BALANCE =>", {
      //   CreditsRemaining: newBalance,
      //   TotalCreditsPurchased: totalCreditsPurchased,
      //   LastCreditsConsumed: totalBillingUnits,
      // });
    } catch (creditUpdateError) {
      console.error("CREDIT UPDATE ERROR:", creditUpdateError);
    }

    let tenantCreditStatus = "Unknown";

    try {
      if (tenantRow) {
        if (newBalance <= 0) {
          tenantCreditStatus = "Exhausted";
        } else if (newBalance <= 20) {
          tenantCreditStatus = "Low Credits";
        } else {
          tenantCreditStatus = "Active";
        }
      }

      if (tenantRow && tenantRow.ROWID) {
        await zcql.executeZCQLQuery(
          `UPDATE apiTenants
SET CreditsLeft=${newBalance},
    CreditStatus='${tenantCreditStatus}',
    LastTopUpDate='${
      latestPayment ? latestPayment.LastTopupDate : tenantRow.LastTopUpDate
    }',
    SubscriptionPlan='${
      latestPayment
        ? latestPayment.SubscriptionPlan
        : tenantRow.SubscriptionPlan
    }',
    SubscriptionStatus='${
      latestPayment
        ? latestPayment.SubscriptionStatus
        : tenantRow.SubscriptionStatus
    }',
    SubscriptionExpiryDate='${
      latestPayment
        ? latestPayment.SubscriptionExpiryDate
        : tenantRow.SubscriptionExpiryDate
    }'
           WHERE ROWID='${tenantRow.ROWID}'`
        );
      }

      // console.log("API TENANT UPDATED:", newBalance, tenantCreditStatus);
    } catch (tenantUpdateError) {
      console.error("API TENANT UPDATE ERROR:", tenantUpdateError);
    }

    // console.log("API TENANT CREDITS UPDATED:", newBalance);

    // ============================================
    // HTAG CONSUMPTION LOG
    // ============================================

    try {
      // console.log("ENTERING HTAG CONSUMPTION LOG BLOCK");

      const insertedRow = await htagConsumptionTable.insertRow({
        ModuleName: "Acquisition",

        RequestId: requestId,

        WidgetName: "Comparable Sales",

        OrgID: orgId,

        APIUnitsConsumed: totalBillingUnits,

        APICost: totalBillingCost,

        FunctionName: "getComparableSales",

        ExecutionDateTime: new Date()
          .toISOString()
          .slice(0, 19)
          .replace("T", " "),

        RecordID: req.headers["x-record-id"] || "",
        CreditCostBreakdown: usageBreakdown.join("\n"),
      });

      // console.log("HTAG INSERT RESULT:", JSON.stringify(insertedRow, null, 2));
    } catch (htagLogError) {
      console.error(
        "HTAG CONSUMPTION LOG ERROR:",
        JSON.stringify(htagLogError, null, 2)
      );
    }

    // ============================================
    // Inserting Log To Data Storage
    // ============================================

    try {
      await usageTable.insertRow({
        Org_ID: req.headers["x-org-id"] || "Unknown Org",

        CRM_User: req.headers["x-crm-user"] || "Unknown User",

        Function_Name: "getComparableSales",

        Feature_Name: "Comparable Sales",

        Record_ID: req.headers["x-record-id"] || "Unknown Record",

        Execution_Time_MS: Date.now() - startTime,

        Status: soldResponse.ok ? "success" : "error",

        API_Consumption: totalBillingUnits,

        Usage_Response: usageBreakdown.join("\n"),
      });
    } catch (loggingError) {
      console.error("LOGGING ERROR:", loggingError);
    }

    // console.log(
    //   "HTAG SOLD SEARCH RESPONSE:",
    //   JSON.stringify(soldData, null, 2)
    // );

    // ============================================
    // HANDLE CREDIT LIMIT
    // ============================================

    if (soldResponse.status === 402) {
      res.writeHead(402, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          error: "payment_required",
          message:
            "Oops! API credits exhausted. Please contact support@agenttime.au",
        })
      );

      return;
    }

    // ============================================
    // HANDLE NO RESULTS
    // ============================================

    if (!soldData.results || soldData.results.length === 0) {
      res.writeHead(404, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          error: "no_results",
          message: `No comparable sales found for ${address} try again later`,
          searched_address: address,
          address_key: addressKey,
          htag_response: soldData,
        })
      );

      return;
    }

    // ============================================
    // SUCCESS RESPONSE
    // ============================================

    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        success: true,
        credit_data: {
          available_credits: newBalance,
          last_credits_consumed: totalBillingUnits,
          credit_status: tenantCreditStatus,
          last_topup: lastTopup,
          last_topup_date: lastTopupDate,
          total_credits_purchased: totalCreditsPurchased,

          subscription_plan: tenantRow.SubscriptionPlan,
          subscription_status: tenantRow.SubscriptionStatus,
          subscription_expiry_date: tenantRow.SubscriptionExpiryDate,
        },
        input_address: address,
        address_key: addressKey,
        total_results: soldData.total || 0,
        comparable_sales: soldData.results.map((item) => ({
          street_address: item.street_address || "",

          suburb: item.suburb || "",

          sold_price: item.sold_price || "N/A",

          sold_date: item.sold_date || "",

          bedrooms: item.bedrooms || 0,

          bathrooms: item.bathrooms || 0,

          car_spaces: item.car_spaces || 0,

          land_area: item.land_area || 0,

          property_type: item.property_type || "",
        })),
      })
    );
  } catch (error) {
    try {
      await usageTable.insertRow({
        Org_ID: req.headers["x-org-id"] || "Unknown Org",

        CRM_User: req.headers["x-crm-user"] || "Unknown User",

        Function_Name: "getComparableSales",

        Feature_Name: "Comparable Sales",

        Record_ID: req.headers["x-record-id"] || "Unknown Record",

        Execution_Time_MS: Date.now() - startTime,

        Status: "failed",

        API_Consumption: totalBillingUnits || 0,

        Usage_Response:
          (usageBreakdown || []).join("\n") +
          "\nERROR: " +
          (error.message || "Unknown Error"),
      });
    } catch (loggingError) {
      console.error("FAILURE LOGGING ERROR:", loggingError);
    }

    console.error("SERVER ERROR:", error);

    res.writeHead(500, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        error: "server_error",
        message: error.message,
      })
    );
  }
};
