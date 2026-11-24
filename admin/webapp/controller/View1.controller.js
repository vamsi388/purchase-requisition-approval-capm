sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/ui/core/format/NumberFormat"
], (Controller, JSONModel, MessageBox, MessageToast, NumberFormat) => {
    "use strict";

    const ROLES = ["Manager", "Finance"];
    const AMOUNT = NumberFormat.getFloatInstance({ minFractionDigits: 2, maxFractionDigits: 2 });
    const SEVERITY = { Error: 0, Warning: 1, Information: 2 };

    // ApprovalMatrix, CostCentres, PurchaseCategories and Materials live in AdminService (model "admin").
    // RequisitionService (default model, called "main" here) has none of the matrix data.
    const PAGES = {
        dashboard: "dashboardPage", matrix: "matrixPage", cc: "ccPage", cat: "catPage",
        mat: "matPage", sim: "simPage", health: "healthPage"
    };
    const ADMIN = "admin";
    const MAIN = "main";

    // object pages: page id, layout id, side menu key and the method that fills their model
    const DETAIL = {
        cc: { page: "ccDetailPage", layout: "ccDetailLayout", menu: "cc", build: "_buildCcDetail" },
        cat: { page: "catDetailPage", layout: "catDetailLayout", menu: "cat", build: "_buildCatDetail" },
        mat: { page: "matDetailPage", layout: "matDetailLayout", menu: "mat", build: "_buildMatDetail" },
        mx: { page: "mxDetailPage", layout: "mxDetailLayout", menu: "matrix", build: "_buildMxDetail" }
    };

    const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const blank = v => v === "" || v === null || v === undefined;
    const clean = v => (blank(v) ? "" : String(v).trim());
    const lower = v => (blank(v) ? "" : String(v).toLowerCase());
    const orNull = v => (clean(v) === "" ? null : clean(v));

    // backend rows -> plain numbers and booleans
    const normMatrix = m => ({
        ID: m.ID,
        orgUnit: m.orgUnit || "",
        category_code: m.category_code || "",
        currency_code: m.currency_code || "",
        minAmount: Number(m.minAmount) || 0,
        maxAmount: blank(m.maxAmount) ? null : Number(m.maxAmount),
        stepNo: Number(m.stepNo),
        approverRole: m.approverRole,
        active: !!m.active
    });
    const normCc = c => {
        const nBudget = Number(c.budgetAmount) || 0;
        const nCommitted = Number(c.committedAmount) || 0;
        return {
            code: c.code, name: c.name || "", orgUnit: c.orgUnit || "",
            managerId: c.managerId || "", financeApproverId: c.financeApproverId || "",
            currency_code: c.currency_code || "",
            budgetAmount: nBudget, committedAmount: nCommitted,
            availableBudget: blank(c.availableBudget) ? r2(nBudget - nCommitted) : Number(c.availableBudget),
            active: !!c.active
        };
    };
    const normMat = m => ({
        code: m.code,
        description: m.description || "",
        uom: m.uom || "",
        unitPrice: Number(m.unitPrice) || 0
    });

    return Controller.extend("admin.controller.View1", {

        // ------------------------------------------------------------------
        // lifecycle
        // ------------------------------------------------------------------
        onInit() {
            this._mCsrf = {};
            this._mMatUsage = null;       // requisition items per material code (null = not loaded)
            this._detail = null;          // object page that is open: { type, key }
            this._oUi = new JSONModel({
                busy: false, forbidden: false, page: "dashboard", sideExpanded: true,
                badge: "", greeting: "", todayText: "", quickVisible: true, ccTotalText: "",
                matrixSearch: "", matrixActive: "All", ccSearch: "", ccActive: "All", catSearch: "",
                matSearch: "",
                matrixCount: 0, ccCount: 0, catCount: 0, matCount: 0, healthCount: 0,
                stats: { steps: 0, ccActive: 0, ccTotal: 0, cats: 0 }
            });
            this._oData = new JSONModel({
                matrix: [], costCentres: [], categories: [], materials: [], currencies: [], orgUnits: [], catOptions: [],
                catOptionsDb: [], matrixView: [], ccView: [], catView: [], matView: []
            });
            this._oMx = new JSONModel({});
            this._oCc = new JSONModel({});
            this._oCat = new JSONModel({});
            this._oMat = new JSONModel({});
            this._oSim = new JSONModel({
                amount: 0, currency: "", costCentre: "", category: "",
                steps: [], message: "", type: "Information", budgetText: "", budgetType: "Information",
                hasResult: false
            });
            this._oHealth = new JSONModel({ issues: [] });
            this._oDash = new JSONModel({ topCc: [], stepsTop: [], activity: [] });

            const oView = this.getView();
            oView.setModel(this._oUi, "ui");
            oView.setModel(this._oData, "data");
            oView.setModel(this._oMx, "mx");
            oView.setModel(this._oCc, "cc");
            oView.setModel(this._oCat, "cat");
            oView.setModel(this._oMat, "mat");
            oView.setModel(this._oSim, "sim");
            oView.setModel(this._oHealth, "health");
            oView.setModel(this._oDash, "dash");
            oView.setModel(new JSONModel({}), "ccd");     // cost centre object page
            oView.setModel(new JSONModel({}), "catd");    // category object page
            oView.setModel(new JSONModel({}), "matd");    // material object page
            oView.setModel(new JSONModel({}), "mxd");     // approval matrix object page

            this._loadAll();
        },

        // ------------------------------------------------------------------
        // formatters
        // ------------------------------------------------------------------
        fmtAmount(vValue) {
            return AMOUNT.format(Number(vValue) || 0);
        },

        fmtMax(vValue) {
            return vValue === null || vValue === undefined ? this._t("noLimit") : AMOUNT.format(Number(vValue));
        },

        roleState(sRole) {
            return sRole === "Manager" ? "Information" : sRole === "Finance" ? "Success" : "None";
        },

        usage(vCommitted, vBudget) {
            const nBudget = Number(vBudget);
            if (!nBudget) { return 0; }
            return Math.max(0, Math.min(100, (Number(vCommitted) / nBudget) * 100));
        },

        usageText(vCommitted, vBudget) {
            const nBudget = Number(vBudget);
            return nBudget ? `${Math.round((Number(vCommitted) / nBudget) * 100)} %` : "-";
        },

        usageState(vCommitted, vBudget) {
            const nBudget = Number(vBudget);
            if (!nBudget) { return "None"; }
            const nShare = Number(vCommitted) / nBudget;
            return nShare > 1 ? "Error" : nShare > 0.85 ? "Warning" : "Success";
        },

        // category code from the name: "IT Equipment" -> ITE, if taken -> ITE1, ITE2 ...
        // (only used when the admin leaves the code empty)
        _genCatCode(sName) {
            const aUsed = this._oData.getProperty("/categories").map(c => String(c.code).toUpperCase());
            const sBase = (sName || "").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 3) || "CAT";
            let sCode = sBase;
            for (let i = 1; aUsed.includes(sCode); i++) {
                sCode = sBase + i;
            }
            return sCode;
        },

        // ------------------------------------------------------------------
        // helpers: texts, backend calls, errors
        // ------------------------------------------------------------------
        _t(sKey, aArgs) {
            return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(sKey, aArgs);
        },

        // sService: "admin" (default) = AdminService, "main" = RequisitionService (default model)
        _serviceUrl(sService = ADMIN) {
            const oModel = this.getOwnerComponent().getModel(sService === MAIN ? undefined : sService);
            const sUrl = oModel.getServiceUrl();
            return sUrl.endsWith("/") ? sUrl : sUrl + "/";
        },

        // CSRF token is needed behind the approuter on BTP, harmless locally; one token per service
        async _csrf(sService = ADMIN) {
            if (!this._mCsrf[sService]) {
                const oRes = await fetch(this._serviceUrl(sService), {
                    method: "GET", credentials: "same-origin",
                    headers: { "X-CSRF-Token": "Fetch" }
                });
                this._mCsrf[sService] = oRes.headers.get("X-CSRF-Token") || "none";
            }
            return this._mCsrf[sService];
        },

        async _toError(oRes) {
            const oErr = new Error("HTTP " + oRes.status);
            oErr.status = oRes.status;
            try {
                const oJson = await oRes.json();
                const oBody = oJson.error || {};
                const aDetails = (oBody.details || []).map(d => d.message).filter(Boolean);
                oErr.message = aDetails.length ? aDetails.join("; ") : (oBody.message || oErr.message);
            } catch (e) { /* body is not JSON */ }
            return oErr;
        },

        async _send(sMethod, sPath, oBody, sService = ADMIN) {
            const call = async () => fetch(this._serviceUrl(sService) + sPath, {
                method: sMethod,
                credentials: "same-origin",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "X-CSRF-Token": await this._csrf(sService)
                },
                body: oBody === undefined ? undefined : JSON.stringify(oBody)
            });
            let oRes = await call();
            if (oRes.status === 403 && oRes.headers.get("X-CSRF-Token") === "Required") {
                this._mCsrf[sService] = null;             // token expired: fetch a new one once
                oRes = await call();
            }
            if (!oRes.ok) { throw await this._toError(oRes); }
            if (oRes.status === 204) { return null; }
            const sText = await oRes.text();
            return sText ? JSON.parse(sText) : null;
        },

        async _busy(fnWork) {
            this._oUi.setProperty("/busy", true);
            try { return await fnWork(); }
            finally { this._oUi.setProperty("/busy", false); }
        },

        _fail(oError) {
            console.error(oError);
            if (oError.status === 403 || oError.status === 401) {
                this._oUi.setProperty("/forbidden", true);
                MessageBox.error(this._t("errNoRole"));
            } else {
                MessageBox.error(oError.message);
            }
        },

        _showErrors(aErrors) {
            MessageBox.error(this._t("validationTitle"),
                { details: "<ul><li>" + aErrors.join("</li><li>") + "</li></ul>" });
        },

        // ------------------------------------------------------------------
        // loading (all from AdminService)
        // ------------------------------------------------------------------
        async _loadAll() {
            try {
                await this._busy(() => this._reload());
                this._oUi.setProperty("/forbidden", false);
            } catch (oError) {
                this._fail(oError);
            }
        },

        // currencies: AdminService first, then RequisitionService, otherwise the ones already in use
        async _loadCurrencies() {
            for (const sService of [ADMIN, MAIN]) {
                try {
                    const oRes = await this._send("GET", "Currencies?$orderby=code", undefined, sService);
                    return (oRes && oRes.value) || [];
                } catch (e) { /* try the next service */ }
            }
            return [];
        },

        // how many requisition items use each material (RequisitionService); null = could not be loaded
        async _loadMatUsage() {
            try {
                const oRes = await this._send("GET", "RequisitionItems", undefined, MAIN);
                const m = {};
                ((oRes && oRes.value) || []).forEach(i => {
                    const k = i.material_code || i.material;
                    if (k) { m[k] = (m[k] || 0) + 1; }
                });
                return m;
            } catch (e) {
                return null;
            }
        },

        async _reload() {
            const [oMx, oCc, oCat, aCur, oMat, mUsage] = await Promise.all([
                this._send("GET", "ApprovalMatrix?$orderby=stepNo,minAmount"),
                this._send("GET", "CostCentres?$orderby=code"),
                this._send("GET", "PurchaseCategories?$orderby=code"),
                this._loadCurrencies(),
                this._send("GET", "Materials?$orderby=code"),
                this._loadMatUsage()
            ]);
            this._mMatUsage = mUsage;

            const matrix = ((oMx && oMx.value) || []).map(normMatrix);
            const costCentres = ((oCc && oCc.value) || []).map(normCc);
            const categories = ((oCat && oCat.value) || []).map(c => ({
                code: c.code, name: c.name || "",
                defaultTaxRate: Number(c.defaultTaxRate) || 0,
                label: `${c.code} - ${c.name || ""}`
            }));
            const materials = ((oMat && oMat.value) || []).map(normMat);
            const currencies = [...new Set([
                ...aCur.map(c => c.code),
                ...costCentres.map(c => c.currency_code),
                ...matrix.map(m => m.currency_code)
            ].filter(Boolean))].sort().map(code => ({ code }));
            const orgUnits = [...new Set([
                ...costCentres.map(c => c.orgUnit), ...matrix.map(m => m.orgUnit)
            ].filter(Boolean))].sort().map(value => ({ value }));

            this._oData.setData({
                matrix, costCentres, categories, materials, currencies, orgUnits,
                catOptions: [{ code: "", label: this._t("anyCategory") }, ...categories],
                // code / name dropdown of the category dialog = what is saved in HANA
                catOptionsDb: categories.map(c => ({
                    code: String(c.code).toUpperCase(), name: c.name, tax: c.defaultTaxRate
                })),
                matrixView: [], ccView: [], catView: [], matView: []
            });
            this._applyViews();
            this._runHealth();
            this._simulate();
            this._refreshDetail();                        // keep an open object page up to date
        },

        onRefreshAll() {
            this._loadAll();
        },

        // ------------------------------------------------------------------
        // table views: filter, search, sort (client side, the lists are small)
        // ------------------------------------------------------------------
        _applyViews() {
            const u = this._oUi.getData();
            const d = this._oData.getData();
            const byActive = (sFilter, bActive) => sFilter === "All" || (sFilter === "Active") === !!bActive;

            const sMx = lower(u.matrixSearch);
            const matrixView = d.matrix
                .filter(m => byActive(u.matrixActive, m.active) && (!sMx ||
                    [m.orgUnit, m.category_code, m.currency_code, m.approverRole, String(m.stepNo)]
                        .some(v => lower(v).includes(sMx))))
                .sort((a, b) => a.stepNo - b.stepNo || a.minAmount - b.minAmount);

            const sCc = lower(u.ccSearch);
            const ccView = d.costCentres
                .filter(c => byActive(u.ccActive, c.active) && (!sCc ||
                    [c.code, c.name, c.orgUnit, c.managerId, c.financeApproverId]
                        .some(v => lower(v).includes(sCc))));

            const sCat = lower(u.catSearch);
            const catView = d.categories
                .filter(c => !sCat || [c.code, c.name].some(v => lower(v).includes(sCat)));

            const sMat = lower(u.matSearch);
            const matView = d.materials
                .filter(m => !sMat || [m.code, m.description, m.uom].some(v => lower(v).includes(sMat)));

            this._oData.setProperty("/matrixView", matrixView);
            this._oData.setProperty("/ccView", ccView);
            this._oData.setProperty("/catView", catView);
            this._oData.setProperty("/matView", matView);
            this._oUi.setProperty("/matrixCount", matrixView.length);
            this._oUi.setProperty("/ccCount", ccView.length);
            this._oUi.setProperty("/catCount", catView.length);
            this._oUi.setProperty("/matCount", matView.length);
            this._oUi.setProperty("/stats", {
                steps: d.matrix.filter(m => m.active).length,
                ccActive: d.costCentres.filter(c => c.active).length,
                ccTotal: d.costCentres.length,
                cats: d.categories.length
            });
            this._oUi.setProperty("/ccTotalText", this._t("statOfTotal", [d.costCentres.length]));
        },

        onViewChange() { this._applyViews(); },

        _searchValue(oEvent) {
            const sQuery = oEvent.getParameter("query");
            return (sQuery !== undefined ? sQuery : (oEvent.getParameter("newValue") || "")).trim();
        },

        onMatrixSearch(oEvent) { this._oUi.setProperty("/matrixSearch", this._searchValue(oEvent)); this._applyViews(); },
        onCcSearch(oEvent) { this._oUi.setProperty("/ccSearch", this._searchValue(oEvent)); this._applyViews(); },
        onCatSearch(oEvent) { this._oUi.setProperty("/catSearch", this._searchValue(oEvent)); this._applyViews(); },
        onMatSearch(oEvent) { this._oUi.setProperty("/matSearch", this._searchValue(oEvent)); this._applyViews(); },

        // ------------------------------------------------------------------
        // route logic: the same rules as buildRoute in the backend
        // ------------------------------------------------------------------
        _route(aMatrix, o) {
            const nTotal = Number(o.amount);
            const aMatch = aMatrix.filter(m => m.active &&
                (!m.currency_code || m.currency_code === o.currency) &&
                (!m.orgUnit || m.orgUnit === o.orgUnit) &&
                (!m.category_code || m.category_code === o.category) &&
                nTotal >= m.minAmount && (m.maxAmount === null || nTotal <= m.maxAmount));
            const mByStep = new Map();                    // same step twice: the most specific row wins
            aMatch.forEach(m => {
                const nScore = (m.orgUnit ? 1 : 0) + (m.category_code ? 1 : 0);
                const oCur = mByStep.get(m.stepNo);
                if (!oCur || nScore > oCur.score) { mByStep.set(m.stepNo, { ...m, score: nScore }); }
            });
            return [...mByStep.values()].sort((a, b) => a.stepNo - b.stepNo);
        },

        _scope(m) {
            return `${m.currency_code || ""}|${m.orgUnit || ""}|${m.category_code || ""}`;
        },

        // active rows of the same step and scope whose amount range overlaps: the winner would be unclear
        _overlaps(oRow, sExcludeId) {
            const nMax = v => (v === null ? Infinity : v);
            return this._oData.getProperty("/matrix").filter(m =>
                m.active && m.ID !== sExcludeId && m.stepNo === oRow.stepNo &&
                this._scope(m) === this._scope(oRow) &&
                m.minAmount <= nMax(oRow.maxAmount) && oRow.minAmount <= nMax(m.maxAmount));
        },

        _ruleText(m) {
            return this._t("ruleText", [
                m.orgUnit || this._t("any"), m.category_code || this._t("any"), m.currency_code || this._t("any"),
                AMOUNT.format(m.minAmount), m.maxAmount === null ? this._t("noLimit") : AMOUNT.format(m.maxAmount)
            ]);
        },

        // ------------------------------------------------------------------
        // approval matrix: create, edit, toggle, delete
        // ------------------------------------------------------------------
        onAddMatrix() {
            const aRows = this._oData.getProperty("/matrix");
            this._oMx.setData({
                mode: "create", title: this._t("mxCreateTitle"), id: null,
                stepNo: String(aRows.length ? Math.max(...aRows.map(m => m.stepNo)) : 1),
                approverRole: "Manager", minAmount: "0", maxAmount: "",
                orgUnit: "", category_code: "", currency_code: "", active: true
            });
            this.byId("matrixDialog").open();
        },

        onEditMatrix(oEvent) {
            this._editMatrix(oEvent.getSource().getBindingContext("data").getObject());
        },

        _editMatrix(o) {
            this._oMx.setData({
                mode: "edit", title: this._t("mxEditTitle"), id: o.ID,
                stepNo: String(o.stepNo), approverRole: o.approverRole,
                minAmount: String(o.minAmount), maxAmount: o.maxAmount === null ? "" : String(o.maxAmount),
                orgUnit: o.orgUnit, category_code: o.category_code, currency_code: o.currency_code, active: o.active
            });
            this.byId("matrixDialog").open();
        },

        onCloseMatrix() {
            this.byId("matrixDialog").close();
        },

        _validateMatrix(d) {
            const aErr = [];
            const nStep = Number(d.stepNo);
            if (blank(d.stepNo) || !Number.isInteger(nStep) || nStep < 1) { aErr.push(this._t("vStep")); }
            if (!ROLES.includes(d.approverRole)) { aErr.push(this._t("vRole")); }
            const nMin = blank(d.minAmount) ? NaN : Number(d.minAmount);
            if (isNaN(nMin) || nMin < 0) { aErr.push(this._t("vMin")); }
            if (!blank(d.maxAmount)) {
                const nMax = Number(d.maxAmount);
                if (isNaN(nMax)) { aErr.push(this._t("vMax")); }
                else if (!isNaN(nMin) && nMax < nMin) { aErr.push(this._t("vMaxLow")); }
            }
            const sCur = clean(d.currency_code).toUpperCase();
            if (sCur && !/^[A-Z]{3}$/.test(sCur)) { aErr.push(this._t("vCurrencyAny")); }
            return aErr;
        },

        async onSaveMatrix() {
            const d = this._oMx.getData();
            const aErr = this._validateMatrix(d);
            if (aErr.length) { this._showErrors(aErr); return; }

            const oRow = {
                stepNo: Number(d.stepNo), approverRole: d.approverRole,
                minAmount: Number(d.minAmount), maxAmount: blank(d.maxAmount) ? null : Number(d.maxAmount),
                orgUnit: clean(d.orgUnit), category_code: clean(d.category_code),
                currency_code: clean(d.currency_code).toUpperCase(), active: !!d.active
            };
            const oBody = {
                ...oRow,
                orgUnit: orNull(oRow.orgUnit), category_code: orNull(oRow.category_code),
                currency_code: orNull(oRow.currency_code)
            };

            const fnSave = async () => {
                try {
                    await this._busy(async () => {
                        if (d.mode === "edit") { await this._send("PATCH", `ApprovalMatrix(${d.id})`, oBody); }
                        else { await this._send("POST", "ApprovalMatrix", oBody); }
                        await this._reload();
                    });
                    this.byId("matrixDialog").close();
                    MessageToast.show(this._t("savedMatrix"));
                } catch (e) { this._fail(e); }
            };

            const aOverlap = oRow.active ? this._overlaps(oRow, d.id) : [];
            if (aOverlap.length) {
                MessageBox.confirm(this._t("confirmOverlap", [aOverlap.length]), {
                    actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
                    onClose: s => { if (s === MessageBox.Action.OK) { fnSave(); } }
                });
            } else {
                fnSave();
            }
        },

        async onToggleMatrix(oEvent) {
            const bState = oEvent.getParameter("state");
            const o = oEvent.getSource().getBindingContext("data").getObject();
            try {
                await this._busy(async () => {
                    await this._send("PATCH", `ApprovalMatrix(${o.ID})`, { active: bState });
                    await this._reload();
                });
                MessageToast.show(this._t(bState ? "stepActivated" : "stepDeactivated"));
            } catch (e) {
                this._fail(e);
                this._loadAll();                          // put the switch back to the stored value
            }
        },

        onDeleteMatrix(oEvent) {
            const o = oEvent.getSource().getBindingContext("data").getObject();
            MessageBox.confirm(this._t("confirmDeleteMatrix", [o.stepNo, o.approverRole]), {
                actions: [MessageBox.Action.DELETE, MessageBox.Action.CANCEL],
                emphasizedAction: MessageBox.Action.DELETE,
                onClose: async s => {
                    if (s !== MessageBox.Action.DELETE) { return; }
                    try {
                        await this._busy(async () => {
                            await this._send("DELETE", `ApprovalMatrix(${o.ID})`);
                            await this._reload();
                        });
                        MessageToast.show(this._t("deletedMatrix"));
                    } catch (e) { this._fail(e); }
                }
            });
        },

        // ------------------------------------------------------------------
        // cost centres: create, edit, toggle, delete
        // ------------------------------------------------------------------
        onAddCc() {
            this._oCc.setData({
                mode: "create", title: this._t("ccCreateTitle"), code: "",
                name: "", orgUnit: "", managerId: "", financeApproverId: "",
                currency_code: "", budgetAmount: 0, committedAmount: 0, active: true
            });
            this.byId("ccDialog").open();
        },

        onEditCc(oEvent) {
            this._editCc(oEvent.getSource().getBindingContext("data").getObject());
        },

        _editCc(o) {
            this._oCc.setData({
                mode: "edit", title: this._t("ccEditTitle", [o.code]), code: o.code,
                name: o.name, orgUnit: o.orgUnit, managerId: o.managerId, financeApproverId: o.financeApproverId,
                currency_code: o.currency_code, budgetAmount: Number(o.budgetAmount),
                committedAmount: o.committedAmount, active: o.active
            });
            this.byId("ccDialog").open();
        },

        onCloseCc() {
            this.byId("ccDialog").close();
        },

        _validateCc(d) {
            const aErr = [];
            if (!clean(d.name)) { aErr.push(this._t("vName")); }
            if (!clean(d.orgUnit)) { aErr.push(this._t("vOrgUnit")); }
            if (!/^[A-Z]{3}$/.test(clean(d.currency_code).toUpperCase())) { aErr.push(this._t("vCurrency")); }
            const nBudget = blank(d.budgetAmount) ? NaN : Number(d.budgetAmount);
            if (isNaN(nBudget) || nBudget < 0) { aErr.push(this._t("vBudget")); }
            else if (d.mode === "edit" && nBudget < Number(d.committedAmount)) {
                aErr.push(this._t("vBudgetLow", [AMOUNT.format(Number(d.committedAmount))]));
            }
            return aErr;
        },

        async onSaveCc() {
            const d = this._oCc.getData();
            const aErr = this._validateCc(d);
            if (aErr.length) { this._showErrors(aErr); return; }

            const oBody = {
                name: clean(d.name), orgUnit: clean(d.orgUnit),
                managerId: orNull(d.managerId), financeApproverId: orNull(d.financeApproverId),
                currency_code: clean(d.currency_code).toUpperCase(),
                budgetAmount: Number(d.budgetAmount), active: !!d.active
            };
            try {
                await this._busy(async () => {
                    if (d.mode === "edit") {
                        await this._send("PATCH", `CostCentres('${encodeURIComponent(d.code)}')`, oBody);
                    } else {
                        // the system generates the code, whatever is sent here
                        await this._send("POST", "CostCentres", { ...oBody, code: "AUTO" });
                    }
                    await this._reload();
                });
                this.byId("ccDialog").close();
                MessageToast.show(this._t("savedCc"));
            } catch (e) { this._fail(e); }
        },

        async onToggleCc(oEvent) {
            const bState = oEvent.getParameter("state");
            const o = oEvent.getSource().getBindingContext("data").getObject();
            try {
                await this._busy(async () => {
                    await this._send("PATCH", `CostCentres('${encodeURIComponent(o.code)}')`, { active: bState });
                    await this._reload();
                });
                MessageToast.show(this._t(bState ? "ccActivated" : "ccDeactivated", [o.code]));
            } catch (e) {
                this._fail(e);
                this._loadAll();
            }
        },

        onDeleteCc(oEvent) {
            const o = oEvent.getSource().getBindingContext("data").getObject();
            MessageBox.confirm(this._t("confirmDeleteCc", [o.code]), {
                actions: [MessageBox.Action.DELETE, MessageBox.Action.CANCEL],
                emphasizedAction: MessageBox.Action.DELETE,
                onClose: async s => {
                    if (s !== MessageBox.Action.DELETE) { return; }
                    try {
                        await this._busy(async () => {
                            await this._send("DELETE", `CostCentres('${encodeURIComponent(o.code)}')`);
                            await this._reload();
                        });
                        MessageToast.show(this._t("deletedCc", [o.code]));
                    } catch (e) { this._fail(e); }         // for example: used by requisitions, deactivate it instead
                }
            });
        },

        // ------------------------------------------------------------------
        // purchase categories: create, edit, delete
        // ------------------------------------------------------------------
        onAddCat() {
            this._loadCatOptions();
            this._oCat.setData({
                mode: "create", title: this._t("catCreateTitle"), code: "", name: "",
                defaultTaxRate: 0, exists: false
            });
            this.byId("catDialog").open();
        },

        onEditCat(oEvent) {
            this._editCat(oEvent.getSource().getBindingContext("data").getObject());
        },

        _editCat(o) {
            this._oCat.setData({
                mode: "edit", title: this._t("catEditTitle", [o.code]),
                code: o.code, name: o.name, defaultTaxRate: Number(o.defaultTaxRate), exists: false
            });
            this.byId("catDialog").open();
        },

        onCloseCat() {
            this.byId("catDialog").close();
        },

        _validateCat(d) {
            const aErr = [];
            const sCode = clean(d.code).toUpperCase();
            if (!/^[A-Z0-9_-]{1,10}$/.test(sCode)) { aErr.push(this._t("vCode")); }
            else if (d.mode === "create" && this._oData.getProperty("/categories").some(c => c.code === sCode)) {
                aErr.push(this._t("vCodeExists", [sCode]));
            }
            if (!clean(d.name)) { aErr.push(this._t("vName")); }
            const nTax = blank(d.defaultTaxRate) ? NaN : Number(d.defaultTaxRate);
            if (isNaN(nTax) || nTax < 0 || nTax > 100) { aErr.push(this._t("vTax")); }
            return aErr;
        },

        // code / name dropdown list = what is saved in HANA right now
        async _loadCatOptions() {
            try {
                const oRes = await this._send("GET",
                    "PurchaseCategories?$select=code,name,defaultTaxRate&$orderby=code");
                this._oData.setProperty("/catOptionsDb",
                    ((oRes && oRes.value) || []).map(c => ({
                        code: String(c.code).toUpperCase(),
                        name: c.name,
                        tax: Number(c.defaultTaxRate) || 0
                    })));
            } catch (e) {
                console.error("Could not load categories", e);
            }
        },

        // picking a saved category fills the form from HANA and switches to edit mode
        onCatPick: function (oEvent) {
            var oItem = oEvent.getParameter("selectedItem");
            if (!oItem) { return; }
            var sCode = oItem.getKey();
            var oData = this.getView().getModel("data");
            var oCat = this.getView().getModel("cat");

            var oCc = (oData.getProperty("/costCentres") || []).find(function (c) {
                return c.code === sCode;
            });
            if (oCc) {
                oCat.setProperty("/code", oCc.code);
                oCat.setProperty("/name", oCc.name);
            }

            // warn if a category with this code already exists
            var bExists = (oData.getProperty("/categories") || []).some(function (c) {
                return c.code === sCode;
            });
            oCat.setProperty("/exists", bExists);
        },

        async onSaveCat() {
            // no code typed or picked: generate one from the name
            if (this._oCat.getProperty("/mode") === "create" && !clean(this._oCat.getProperty("/code"))
                && clean(this._oCat.getProperty("/name"))) {
                this._oCat.setProperty("/code", this._genCatCode(this._oCat.getProperty("/name")));
            }
            const d = this._oCat.getData();
            const aErr = this._validateCat(d);
            if (aErr.length) { this._showErrors(aErr); return; }

            const sCode = clean(d.code).toUpperCase();
            const oBody = { name: clean(d.name), defaultTaxRate: Number(d.defaultTaxRate) };
            try {
                await this._busy(async () => {
                    if (d.mode === "edit") {
                        await this._send("PATCH", `PurchaseCategories('${encodeURIComponent(sCode)}')`, oBody);
                    } else {
                        await this._send("POST", "PurchaseCategories", { ...oBody, code: sCode });
                    }
                    await this._reload();
                });
                this.byId("catDialog").close();
                MessageToast.show(this._t("savedCat"));
            } catch (e) { this._fail(e); }
        },

        onDeleteCat(oEvent) {
            const o = oEvent.getSource().getBindingContext("data").getObject();
            MessageBox.confirm(this._t("confirmDeleteCat", [o.code]), {
                actions: [MessageBox.Action.DELETE, MessageBox.Action.CANCEL],
                emphasizedAction: MessageBox.Action.DELETE,
                onClose: async s => {
                    if (s !== MessageBox.Action.DELETE) { return; }
                    try {
                        await this._busy(async () => {
                            await this._send("DELETE", `PurchaseCategories('${encodeURIComponent(o.code)}')`);
                            await this._reload();
                        });
                        MessageToast.show(this._t("deletedCat", [o.code]));
                    } catch (e) { this._fail(e); }
                }
            });
        },

        // ------------------------------------------------------------------
        // materials: create, edit, delete
        // ------------------------------------------------------------------
        onAddMat() {
            this._oMat.setData({
                mode: "create", title: this._t("matCreateTitle"),
                code: "", description: "", uom: "EA", unitPrice: 100
            });
            this.byId("matDialog").open();
        },

        onEditMat(oEvent) {
            this._editMat(oEvent.getSource().getBindingContext("data").getObject());
        },

        _editMat(o) {
            this._oMat.setData({
                mode: "edit", title: this._t("matEditTitle", [o.code]),
                code: o.code, description: o.description, uom: o.uom, unitPrice: Number(o.unitPrice)
            });
            this.byId("matDialog").open();
        },

        onCloseMat() {
            this.byId("matDialog").close();
        },

        _validateMat(d) {
            const aErr = [];
            const sCode = clean(d.code);
            if (!sCode) { aErr.push(this._t("vMatCode")); }
            else if (d.mode === "create" &&
                this._oData.getProperty("/materials").some(m => String(m.code).toUpperCase() === sCode.toUpperCase())) {
                aErr.push(this._t("vMatExists", [sCode]));
            }
            if (!clean(d.description)) { aErr.push(this._t("vMatDescription")); }
            if (!clean(d.uom)) { aErr.push(this._t("vMatUom")); }
            const nPrice = blank(d.unitPrice) ? NaN : Number(d.unitPrice);
            if (isNaN(nPrice) || nPrice < 0) { aErr.push(this._t("vMatPrice")); }
            return aErr;
        },

        async onSaveMat() {
            const d = this._oMat.getData();
            const aErr = this._validateMat(d);
            if (aErr.length) { this._showErrors(aErr); return; }

            const sCode = clean(d.code);
            const oBody = {
                description: clean(d.description),
                uom: clean(d.uom).toUpperCase(),
                unitPrice: Number(d.unitPrice)
            };
            try {
                await this._busy(async () => {
                    if (d.mode === "edit") {
                        await this._send("PATCH", `Materials('${encodeURIComponent(sCode)}')`, oBody);
                    } else {
                        await this._send("POST", "Materials", { ...oBody, code: sCode });
                    }
                    await this._reload();
                });
                this.byId("matDialog").close();
                MessageToast.show(this._t("savedMat"));
            } catch (e) { this._fail(e); }
        },

        onDeleteMat(oEvent) {
            const o = oEvent.getSource().getBindingContext("data").getObject();
            MessageBox.confirm(this._t("confirmDeleteMat", [o.code]), {
                actions: [MessageBox.Action.DELETE, MessageBox.Action.CANCEL],
                emphasizedAction: MessageBox.Action.DELETE,
                onClose: async s => {
                    if (s !== MessageBox.Action.DELETE) { return; }
                    try {
                        await this._busy(async () => {
                            await this._send("DELETE", `Materials('${encodeURIComponent(o.code)}')`);
                            await this._reload();
                        });
                        MessageToast.show(this._t("deletedMat", [o.code]));
                    } catch (e) { this._fail(e); }         // "used on requisition items" comes from the backend
                }
            });
        },

        // ------------------------------------------------------------------
        // object pages: cost centre, purchase category, material, approval matrix
        // The page models are rebuilt from the loaded data after every reload,
        // so an open page always shows the latest values.
        // ------------------------------------------------------------------
        // approval rules that apply to a cost centre ("any" matches everything)
        _rulesFor(cc) {
            return this._oData.getProperty("/matrix")
                .filter(m => (!m.orgUnit || m.orgUnit === cc.orgUnit) &&
                    (!m.currency_code || m.currency_code === cc.currency_code))
                .sort((a, b) => a.stepNo - b.stepNo || a.minAmount - b.minAmount);
        },

        // number of different active approval steps a cost centre has for a category
        _stepCount(cc, sCat) {
            return new Set(this._rulesFor(cc)
                .filter(m => m.active && (!m.category_code || m.category_code === sCat))
                .map(m => m.stepNo)).size;
        },

        _routeInfo(n) {
            return {
                routeText: n ? this._t("catSteps", [n]) : this._t("catNoRoute"),
                routeState: n ? "Success" : "Error"
            };
        },

        _buildCcDetail(sCode) {
            const cc = this._oData.getProperty("/costCentres").find(c => c.code === sCode);
            if (!cc) { return false; }
            this.getView().getModel("ccd").setData({
                cc: { ...cc },
                matrix: this._rulesFor(cc).map(m => ({ ...m })),
                matrixHint: this._t("matrixForCc", [cc.orgUnit || "-", cc.currency_code || "-"]),
                categories: this._oData.getProperty("/categories").map(c => ({
                    code: c.code, name: c.name, defaultTaxRate: c.defaultTaxRate,
                    ...this._routeInfo(this._stepCount(cc, c.code))
                }))
            });
            return true;
        },

        _buildCatDetail(sCode) {
            const cat = this._oData.getProperty("/categories").find(c => c.code === sCode);
            if (!cat) { return false; }
            const aRules = this._oData.getProperty("/matrix")
                .filter(m => !m.category_code || m.category_code === sCode)
                .sort((a, b) => a.stepNo - b.stepNo || a.minAmount - b.minAmount)
                .map(m => ({ ...m }));
            const aCcs = this._oData.getProperty("/costCentres").map(cc => ({
                code: cc.code, name: cc.name, orgUnit: cc.orgUnit,
                activeText: this._t(cc.active ? "fActive" : "fInactive"),
                activeState: cc.active ? "Success" : "None",
                ...this._routeInfo(this._stepCount(cc, sCode))
            }));
            this.getView().getModel("catd").setData({
                cat: { ...cat }, rules: aRules, rulesHint: this._t("rulesForCat", [sCode]),
                ccs: aCcs, ruleCount: aRules.length, ccCount: aCcs.length
            });
            return true;
        },

        _buildMatDetail(sCode) {
            const mat = this._oData.getProperty("/materials").find(m => m.code === sCode);
            if (!mat) { return false; }
            const bKnown = !!this._mMatUsage;
            const nCount = bKnown ? (this._mMatUsage[sCode] || 0) : 0;
            this.getView().getModel("matd").setData({
                mat: { ...mat },
                usageKnown: bKnown,
                usageCount: nCount,
                usageText: nCount
                    ? this._t("matUsedText", [nCount])
                    : this._t("matUnusedText")
            });
            return true;
        },

        _buildMxDetail(sId) {
            const mx = this._oData.getProperty("/matrix").find(m => m.ID === sId);
            if (!mx) { return false; }
            const aCcs = this._oData.getProperty("/costCentres")
                .filter(cc => (!mx.orgUnit || cc.orgUnit === mx.orgUnit) &&
                    (!mx.currency_code || cc.currency_code === mx.currency_code))
                .map(cc => {
                    const sWho = mx.approverRole === "Manager" ? cc.managerId : cc.financeApproverId;
                    return {
                        code: cc.code, name: cc.name, orgUnit: cc.orgUnit, currency_code: cc.currency_code,
                        assignedTo: sWho || this._t("missing"), state: sWho ? "Success" : "Error"
                    };
                });
            const aAllCats = this._oData.getProperty("/categories");
            const aCats = (mx.category_code ? aAllCats.filter(c => c.code === mx.category_code) : aAllCats)
                .map(c => ({ ...c }));
            const nOverlap = mx.active ? this._overlaps(mx, mx.ID).length : 0;
            this.getView().getModel("mxd").setData({
                mx: { ...mx }, title: this._t("mxTitle", [mx.stepNo, mx.approverRole]),
                ccs: aCcs, cats: aCats, overlap: nOverlap, overlapText: this._t("mxOverlapNote", [nOverlap])
            });
            return true;
        },

        _openDetail(sType, sKey) {
            const o = DETAIL[sType];
            if (!this[o.build](sKey)) { return; }
            this._detail = { type: sType, key: sKey };
            this._oUi.setProperty("/page", o.menu);       // keeps the side menu entry highlighted
            const oLayout = this.byId(o.layout);
            const aSections = oLayout.getSections();
            if (aSections.length) { oLayout.setSelectedSection(aSections[0]); }
            this.byId("nav").to(this.byId(o.page).getId(), "slide");
        },

        _closeDetail(sType) {
            this._detail = null;
            this.byId("nav").to(this.byId(PAGES[DETAIL[sType].menu]).getId(), "slide");
        },

        // called after every reload; closes the page when its record no longer exists
        _refreshDetail() {
            if (!this._detail) { return; }
            const sType = this._detail.type;
            if (!this[DETAIL[sType].build](this._detail.key)) { this._closeDetail(sType); }
        },

        _current(sList, sField) {
            return this._detail
                ? this._oData.getProperty(sList).find(r => r[sField] === this._detail.key)
                : null;
        },

        // ----- cost centre -----
        onOpenCcDetail(oEvent) {
            this._openDetail("cc", oEvent.getSource().getBindingContext("data").getProperty("code"));
        },
        onCcDetailBack() { this._closeDetail("cc"); },
        onCcDetailEdit() {
            const o = this._current("/costCentres", "code");
            if (o) { this._editCc(o); }
        },

        // ----- purchase category -----
        onOpenCatDetail(oEvent) {
            this._openDetail("cat", oEvent.getSource().getBindingContext("data").getProperty("code"));
        },
        onCatDetailBack() { this._closeDetail("cat"); },
        onCatDetailEdit() {
            const o = this._current("/categories", "code");
            if (o) { this._editCat(o); }
        },

        // ----- material -----
        onOpenMatDetail(oEvent) {
            this._openDetail("mat", oEvent.getSource().getBindingContext("data").getProperty("code"));
        },
        onMatDetailBack() { this._closeDetail("mat"); },
        onMatDetailEdit() {
            const o = this._current("/materials", "code");
            if (o) { this._editMat(o); }
        },

        // ----- approval matrix -----
        onOpenMxDetail(oEvent) {
            this._openDetail("mx", oEvent.getSource().getBindingContext("data").getProperty("ID"));
        },
        onMxDetailBack() { this._closeDetail("mx"); },
        onMxDetailEdit() {
            const o = this._current("/matrix", "ID");
            if (o) { this._editMatrix(o); }
        },

        // ------------------------------------------------------------------
        // route simulator
        // ------------------------------------------------------------------
        // picking a cost centre fills currency and amount, then re-runs the simulation
        onSimCostCentre(oEvent) {
            const oItem = oEvent.getParameter("selectedItem");
            if (!oItem) { return; }
            const oCc = oItem.getBindingContext("data").getObject();
            const oSim = this.getView().getModel("sim");

            const nAvail = oCc.availableBudget !== undefined && oCc.availableBudget !== null
                ? Number(oCc.availableBudget)
                : (Number(oCc.budgetAmount) || 0) - (Number(oCc.committedAmount) || 0);

            oSim.setProperty("/currency", oCc.currency_code || "");
            oSim.setProperty("/amount", nAvail > 0 ? nAvail : 0);

            this.onSimChange();
        },

        onSimChange() {
            this._simulate();
        },

        _simulate() {
            const s = this._oSim.getData();
            const set = (aSteps, sText, sType, sBudget, sBudgetType) => {
                this._oSim.setProperty("/steps", aSteps);
                this._oSim.setProperty("/message", sText);
                this._oSim.setProperty("/type", sType);
                this._oSim.setProperty("/budgetText", sBudget || "");
                this._oSim.setProperty("/budgetType", sBudgetType || "Information");
                this._oSim.setProperty("/hasResult", true);
            };

            const nAmount = blank(s.amount) ? NaN : Number(s.amount);
            const oCc = this._oData.getProperty("/costCentres").find(c => c.code === s.costCentre);
            if (isNaN(nAmount) || nAmount <= 0 || !oCc || !s.category) {
                set([], this._t("simPick"), "Information");
                return;
            }

            const aRoute = this._route(this._oData.getProperty("/matrix"), {
                amount: nAmount, currency: clean(s.currency).toUpperCase(),
                orgUnit: oCc.orgUnit, category: s.category
            });
            const aSteps = aRoute.map((m, i) => {
                const sWho = m.approverRole === "Manager" ? oCc.managerId : oCc.financeApproverId;
                return {
                    stepNo: i + 1, role: m.approverRole,
                    assignedTo: sWho || this._t("missing"), state: sWho ? "Success" : "Error",
                    rule: this._ruleText(m)
                };
            });

            let sText, sType;
            if (!aSteps.length) { sText = this._t("simNoRoute"); sType = "Error"; }
            else if (aSteps.some(x => x.state === "Error")) { sText = this._t("simMissing", [oCc.code]); sType = "Warning"; }
            else { sText = this._t("simRoute", [aSteps.length]); sType = "Success"; }

            const bOver = nAmount > oCc.availableBudget;
            set(aSteps, sText, sType,
                this._t(bOver ? "simOverBudget" : "simBudgetOk",
                    [AMOUNT.format(nAmount), AMOUNT.format(oCc.availableBudget), oCc.currency_code]),
                bOver ? "Warning" : "Success");
        },

        // ------------------------------------------------------------------
        // health check
        // ------------------------------------------------------------------
        onRunHealth() {
            this._runHealth();
            MessageToast.show(this._t("healthDone", [this._oHealth.getProperty("/issues").length]));
        },

        _runHealth() {
            const d = this._oData.getData();
            const aIssues = [];
            const add = (sType, sText, sTab) => aIssues.push({ type: sType, text: sText, tab: sTab });
            const aActive = d.matrix.filter(m => m.active);

            // 1. matrix rows
            if (!aActive.length) { add("Error", this._t("hNoSteps"), "matrix"); }
            d.matrix.forEach(m => {
                if (m.maxAmount !== null && m.maxAmount < m.minAmount) {
                    add("Error", this._t("hInvalidRange", [m.stepNo, m.approverRole, this._ruleText(m)]), "matrix");
                }
            });
            for (let i = 0; i < aActive.length; i++) {
                for (let j = i + 1; j < aActive.length; j++) {
                    const a = aActive[i], b = aActive[j];
                    if (a.stepNo !== b.stepNo || this._scope(a) !== this._scope(b)) { continue; }
                    const nMaxA = a.maxAmount === null ? Infinity : a.maxAmount;
                    const nMaxB = b.maxAmount === null ? Infinity : b.maxAmount;
                    if (a.minAmount <= nMaxB && b.minAmount <= nMaxA) {
                        add("Warning", this._t("hOverlap", [a.stepNo, this._ruleText(a), this._ruleText(b)]), "matrix");
                    }
                }
            }

            // 2. coverage: does every active cost centre get a route at the boundary amounts?
            if (aActive.length) {
                const oPoints = new Set([1]);
                let nMaxSeen = 0;
                aActive.forEach(m => {
                    if (m.minAmount > 0) { oPoints.add(m.minAmount); }
                    if (m.maxAmount !== null) {
                        oPoints.add(m.maxAmount);
                        oPoints.add(r2(m.maxAmount + 0.01));
                        nMaxSeen = Math.max(nMaxSeen, m.maxAmount);
                    } else {
                        nMaxSeen = Math.max(nMaxSeen, m.minAmount);
                    }
                });
                oPoints.add(Math.max(nMaxSeen * 10, 1000000));
                const aPoints = [...oPoints].filter(v => v > 0).sort((a, b) => a - b).slice(0, 60);
                const aCats = d.categories.length ? d.categories : [{ code: "" }];

                d.costCentres.filter(c => c.active).forEach(cc => {
                    const mMiss = {};
                    aCats.forEach(cat => {
                        const nMiss = aPoints.find(v => !this._route(d.matrix, {
                            amount: v, currency: cc.currency_code, orgUnit: cc.orgUnit, category: cat.code
                        }).length);
                        if (nMiss !== undefined) { (mMiss[nMiss] = mMiss[nMiss] || []).push(cat.code || "-"); }
                    });
                    Object.entries(mMiss).forEach(([sAmount, aCodes]) => {
                        add("Error", this._t("hNoRoute", [cc.code, AMOUNT.format(Number(sAmount)),
                        cc.currency_code, aCodes.join(", ")]), "matrix");
                    });
                });
            }

            // 3. cost centres
            const fnUses = (sRole, sOrg) => aActive.some(m => m.approverRole === sRole && (!m.orgUnit || m.orgUnit === sOrg));
            d.costCentres.forEach(cc => {
                if (cc.active) {
                    if (!cc.managerId && fnUses("Manager", cc.orgUnit)) { add("Error", this._t("hNoManager", [cc.code]), "cc"); }
                    if (!cc.financeApproverId && fnUses("Finance", cc.orgUnit)) { add("Error", this._t("hNoFinance", [cc.code]), "cc"); }
                    if (cc.managerId && cc.managerId === cc.financeApproverId) {
                        add("Warning", this._t("hSamePerson", [cc.code, cc.managerId]), "cc");
                    }
                }
                if (cc.budgetAmount > 0) {
                    const nShare = cc.committedAmount / cc.budgetAmount;
                    if (nShare > 1) { add("Error", this._t("hOverCommitted", [cc.code]), "cc"); }
                    else if (nShare > 0.9) { add("Warning", this._t("hHighUsage", [cc.code, Math.round(nShare * 100)]), "cc"); }
                } else if (cc.active) {
                    add("Warning", this._t("hNoBudget", [cc.code]), "cc");
                }
                if (!cc.active && cc.committedAmount > 0) {
                    add("Information", this._t("hInactiveCommitted", [cc.code, AMOUNT.format(cc.committedAmount)]), "cc");
                }
            });

            aIssues.sort((x, y) => SEVERITY[x.type] - SEVERITY[y.type]);
            this._oHealth.setProperty("/issues", aIssues);
            this._oUi.setProperty("/healthCount", aIssues.length);
            this._buildDashboard();
        },

        onShowIssue(oEvent) {
            const o = oEvent.getSource().getBindingContext("health").getObject();
            this._goto(o.tab);
        },

        onActivityPress(oEvent) {
            const o = oEvent.getSource().getBindingContext("dash").getObject();
            this._goto(o.tab);
        },

        // ------------------------------------------------------------------
        // navigation
        // ------------------------------------------------------------------
        _goto(sKey) {
            this._detail = null;                          // leaving an object page
            this._oUi.setProperty("/page", sKey);
            this.byId("nav").to(this.byId(PAGES[sKey]).getId(), "show");
        },

        onToggleQuick() {
            this._oUi.setProperty("/quickVisible", !this._oUi.getProperty("/quickVisible"));
        },

        onToggleSide() {
            this._oUi.setProperty("/sideExpanded", !this._oUi.getProperty("/sideExpanded"));
        },

        onNavSelect(oEvent) { this._goto(oEvent.getParameter("item").getKey()); },
        onOpenMatrix() { this._goto("matrix"); },
        onOpenCc() { this._goto("cc"); },
        onOpenCat() { this._goto("cat"); },
        onOpenMat() { this._goto("mat"); },
        onOpenSim() { this._goto("sim"); },
        onOpenHealth() { this._runHealth(); this._goto("health"); },

        // header search: jumps to the first list that has a match
        onGlobalSearch(oEvent) {
            const sQuery = (oEvent.getParameter("query") || "").trim();
            if (!sQuery) { return; }
            const q = lower(sQuery);
            const d = this._oData.getData();
            const hit = (a, aFields) => a.some(r => aFields.some(f => lower(r[f]).includes(q)));
            let sTarget = "";
            if (hit(d.costCentres, ["code", "name", "orgUnit", "managerId", "financeApproverId"])) {
                this._oUi.setProperty("/ccSearch", sQuery); sTarget = "cc";
            } else if (hit(d.matrix, ["orgUnit", "category_code", "currency_code", "approverRole"])) {
                this._oUi.setProperty("/matrixSearch", sQuery); sTarget = "matrix";
            } else if (hit(d.categories, ["code", "name"])) {
                this._oUi.setProperty("/catSearch", sQuery); sTarget = "cat";
            } else if (hit(d.materials, ["code", "description", "uom"])) {
                this._oUi.setProperty("/matSearch", sQuery); sTarget = "mat";
            }
            if (!sTarget) { MessageToast.show(this._t("noSearchHit", [sQuery])); return; }
            this._applyViews();
            this._goto(sTarget);
        },

        // ------------------------------------------------------------------
        // dashboard: lists and charts
        // ------------------------------------------------------------------
        _greeting() {
            const h = new Date().getHours();
            return this._t("heroHello", [this._t(h < 12 ? "greetMorning" : h < 17 ? "greetAfternoon" : "greetEvening")]);
        },

        _buildDashboard() {
            const d = this._oData.getData();
            const aIssues = this._oHealth.getProperty("/issues") || [];

            const aTopCc = d.costCentres.filter(c => c.active).map(c => {
                const nPct = c.budgetAmount ? Math.round(c.committedAmount * 100 / c.budgetAmount) : 0;
                const sKey = nPct > 100 ? "stOver" : nPct >= 85 ? "stWatch" : "stOnTrack";
                return {
                    code: c.code, name: c.name, pct: Math.min(100, nPct), raw: nPct, pctText: nPct + " %",
                    state: nPct > 100 ? "Error" : nPct >= 85 ? "Warning" : "Success", statusText: this._t(sKey)
                };
            }).sort((a, b) => b.raw - a.raw).slice(0, 4);

            const aSteps = d.matrix.slice().sort((a, b) => a.stepNo - b.stepNo || a.minAmount - b.minAmount)
                .slice(0, 5).map(m => ({
                    stepNo: m.stepNo, approverRole: m.approverRole,
                    scope: [m.orgUnit || this._t("any"), m.category_code || this._t("any"), m.currency_code || this._t("any")].join(" / "),
                    range: `${AMOUNT.format(m.minAmount)} - ${m.maxAmount === null ? this._t("noLimit") : AMOUNT.format(m.maxAmount)}`,
                    activeText: this._t(m.active ? "fActive" : "fInactive"), activeState: m.active ? "Success" : "None"
                }));

            this._oDash.setData({ topCc: aTopCc, stepsTop: aSteps, activity: aIssues.slice(0, 4) });
            this._oUi.setProperty("/badge", aIssues.length ? String(aIssues.length) : "");
            this._oUi.setProperty("/greeting", this._greeting());
            this._oUi.setProperty("/todayText", new Date().toLocaleDateString(undefined,
                { month: "long", day: "numeric", year: "numeric" }));

            const oSteps = this.byId("chartSteps");
            const oOrg = this.byId("chartOrg");
            if (oSteps) { oSteps.setContent(this._stepsChart()); }
            if (oOrg) { oOrg.setContent(this._orgDonut()); }
        },

        // active steps per step number, split by approver role (SAP chart colours from the theme)
        _stepsChart() {
            const aActive = this._oData.getProperty("/matrix").filter(m => m.active);
            const aNos = [...new Set(aActive.map(m => m.stepNo))].sort((a, b) => a - b).slice(0, 6);
            const W = 360, H = 190, base = 150, maxH = 100;
            const TEXT = "fill:var(--sapTextColor)";
            const MUTED = "fill:var(--sapContent_LabelColor)";
            const SERIES = [["Manager", "var(--sapChart_OrderedColor_1)"], ["Finance", "var(--sapChart_OrderedColor_2)"]];

            let s = `<div class="admChart"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img">`;
            if (!aNos.length) {
                s += `<text x="10" y="30" font-size="13" style="${MUTED}">${this._esc(this._t("noRows"))}</text>`;
                return s + "</svg></div>";
            }
            const cnt = (n, r) => aActive.filter(m => m.stepNo === n && m.approverRole === r).length;
            const nMax = Math.max(1, ...aNos.map(n => Math.max(cnt(n, "Manager"), cnt(n, "Finance"))));
            const nSlot = W / aNos.length;

            s += `<circle cx="14" cy="10" r="5" style="fill:${SERIES[0][1]}"/><text x="24" y="14" font-size="12" style="${TEXT}">${this._esc(this._t("roleManager"))}</text>`;
            s += `<circle cx="110" cy="10" r="5" style="fill:${SERIES[1][1]}"/><text x="120" y="14" font-size="12" style="${TEXT}">${this._esc(this._t("roleFinance"))}</text>`;
            s += `<line x1="10" y1="${base}" x2="${W - 10}" y2="${base}" style="stroke:var(--sapList_BorderColor)"/>`;

            aNos.forEach((n, i) => {
                SERIES.forEach(([sRole, sColor], j) => {
                    const v = cnt(n, sRole);
                    const h = Math.round(maxH * v / nMax);
                    const x = i * nSlot + nSlot / 2 - 22 + j * 24;
                    s += `<rect x="${x}" y="${base - h}" width="20" height="${h}" rx="2" style="fill:${sColor}"/>`;
                    s += `<text x="${x + 10}" y="${base - h - 5}" text-anchor="middle" font-size="12" style="${TEXT}">${v}</text>`;
                });
                s += `<text x="${i * nSlot + nSlot / 2}" y="${base + 20}" text-anchor="middle" font-size="12" style="${MUTED}">${this._esc(this._t("stepLabel", [n]))}</text>`;
            });
            return s + "</svg></div>";
        },

        // budget share per organisational unit (in the most used currency)
        _orgDonut() {
            const aCc = this._oData.getProperty("/costCentres").filter(c => c.active && c.budgetAmount > 0);
            const W = 360, H = 190;
            const TEXT = "fill:var(--sapTextColor)";
            const MUTED = "fill:var(--sapContent_LabelColor)";
            const COLORS = [1, 2, 3, 4, 5].map(i => `var(--sapChart_OrderedColor_${i})`);

            let s = `<div class="admChart"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img">`;
            if (!aCc.length) {
                s += `<text x="10" y="30" font-size="13" style="${MUTED}">${this._esc(this._t("noRows"))}</text>`;
                return s + "</svg></div>";
            }
            const mCur = {};
            aCc.forEach(c => { mCur[c.currency_code] = (mCur[c.currency_code] || 0) + 1; });
            const sCur = Object.entries(mCur).sort((a, b) => b[1] - a[1])[0][0];
            const mOrg = {};
            aCc.filter(c => c.currency_code === sCur).forEach(c => {
                mOrg[c.orgUnit || "-"] = (mOrg[c.orgUnit || "-"] || 0) + c.budgetAmount;
            });
            let aRows = Object.entries(mOrg).sort((a, b) => b[1] - a[1]);
            if (aRows.length > 5) {
                aRows = [...aRows.slice(0, 4), [this._t("chOthers"), aRows.slice(4).reduce((n, r) => n + r[1], 0)]];
            }
            const nTotal = aRows.reduce((n, r) => n + r[1], 0);
            const R = 52, C = 2 * Math.PI * R;

            s += `<circle cx="90" cy="95" r="${R}" fill="none" stroke-width="22" style="stroke:var(--sapList_BorderColor)"/>`;
            let nOff = 0;
            aRows.forEach(([, v], i) => {
                const nLen = C * v / nTotal;
                s += `<circle cx="90" cy="95" r="${R}" fill="none" stroke-width="22" style="stroke:${COLORS[i % COLORS.length]}" ` +
                    `stroke-dasharray="${nLen} ${C - nLen}" stroke-dashoffset="${-nOff}" transform="rotate(-90 90 95)"/>`;
                nOff += nLen;
            });
            s += `<text x="90" y="95" text-anchor="middle" font-size="15" font-weight="700" style="${TEXT}">${this._esc(sCur)}</text>`;
            s += `<text x="90" y="112" text-anchor="middle" font-size="11" style="${MUTED}">${this._esc(this._t("cardBudgetShort"))}</text>`;
            aRows.forEach(([sOrg, v], i) => {
                const y = 22 + i * 28;
                s += `<circle cx="180" cy="${y}" r="6" style="fill:${COLORS[i % COLORS.length]}"/>`;
                s += `<text x="194" y="${y + 4}" font-size="12.5" style="${TEXT}">${this._esc(sOrg)}  ${Math.round(v * 100 / nTotal)}%</text>`;
            });
            return s + "</svg></div>";
        },

        _esc(v) {
            return String(v).replace(/[&<>"']/g, c =>
                ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
        }
    });
});