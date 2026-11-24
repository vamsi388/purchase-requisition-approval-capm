sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "sap/ui/core/format/NumberFormat",
    "sap/ui/core/format/DateFormat"
], (Controller, JSONModel, Filter, FilterOperator, MessageBox, MessageToast, NumberFormat, DateFormat) => {
    "use strict";

    const STATE = {
        Approved: "Information", Published: "Success", Failed: "Error",
        Pending: "Warning", Done: "Success", Open: "Warning",
        Rejected: "Error", Returned: "Warning", Cancelled: "Error"
    };
    const PAGES = { dashboard: "dashboardPage", queue: "queuePage" };
    // side menu entry that belongs to a queue filter
    const MENU = { Approved: "queue", All: "queue", Failed: "failed", Published: "published" };
    const ALL_STATUSES = ["Approved", "Published", "Failed"];
    const DAY = 24 * 60 * 60 * 1000;
    const AMOUNT = NumberFormat.getFloatInstance({ minFractionDigits: 2, maxFractionDigits: 2 });
    const TODAY = DateFormat.getDateInstance({ pattern: "d MMMM yyyy" });

    const esc = s => String(s).replace(/[&<>"']/g, c =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
    const shorten = (s, n = 90) => (s && s.length > n ? s.slice(0, n - 1) + "..." : (s || ""));

    return Controller.extend("procurement.controller.View1", {

        // ------------------------------------------------------------------
        // lifecycle
        // ------------------------------------------------------------------
        onInit() {
            this._aRows = [];

            this._oUi = new JSONModel({
                page: "dashboard", sideExpanded: true, alertBadge: "",
                busy: false, forbidden: false, count: 0,
                stateFilter: "Approved", search: "", dateFrom: null, dateTo: null,
                greeting: "", today: ""
            });
            this._oDash = new JSONModel({
                ready: 0, failed: 0, published: 0, total: 0,
                valueNum: "0.00", valueScale: "", valueFoot: "",
                alertCount: 0, alertFilter: "Approved", alerts: []
            });
            this._oChat = new JSONModel({
                open: false, input: "",
                chips: [
                    { text: this._t("aiChip1") }, { text: this._t("aiChip2") },
                    { text: this._t("aiChip3") }, { text: this._t("aiChip4") }
                ],
                messages: [{ role: "bot", text: this._t("aiIntro"), pending: false, action: null }]
            });

            const oView = this.getView();
            oView.setModel(this._oUi, "ui");
            oView.setModel(this._oDash, "dash");
            oView.setModel(this._oChat, "chat");

            this._updateGreeting();
            this._loadDashboard();
        },

        // "Good morning, Procurement!" under the page title and today's date
        _updateGreeting() {
            const h = new Date().getHours();
            const sKey = h < 12 ? "greetMorning" : (h < 18 ? "greetAfternoon" : "greetEvening");
            this._oUi.setProperty("/greeting", this._t(sKey, [this._t("userName")]));
            this._oUi.setProperty("/today", TODAY.format(new Date()));
        },

        // ------------------------------------------------------------------
        // formatters
        // ------------------------------------------------------------------
        formatState(sValue) {
            return STATE[sValue] || "None";
        },

        // ------------------------------------------------------------------
        // helpers: texts, dialogs, backend calls, errors
        // ------------------------------------------------------------------
        _t(sKey, aArgs) {
            return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(sKey, aArgs);
        },

        _dlg(sId) {
            const oDialog = this.byId(sId);
            if (!oDialog) { MessageBox.error(this._t("errDialogMissing", [sId])); }
            return oDialog || null;
        },

        _serviceUrl() {
            const sUrl = this.getOwnerComponent().getModel().getServiceUrl();
            return sUrl.endsWith("/") ? sUrl : sUrl + "/";
        },

        // CSRF token is needed behind the approuter on BTP, harmless locally
        async _csrf() {
            if (!this._sCsrf) {
                const oRes = await fetch(this._serviceUrl(), {
                    method: "GET", credentials: "same-origin",
                    headers: { "X-CSRF-Token": "Fetch" }
                });
                this._sCsrf = oRes.headers.get("X-CSRF-Token") || "none";
            }
            return this._sCsrf;
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

        async _send(sMethod, sPath, oBody) {
            const call = async () => fetch(this._serviceUrl() + sPath, {
                method: sMethod,
                credentials: "same-origin",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "X-CSRF-Token": await this._csrf()
                },
                body: oBody === undefined ? undefined : JSON.stringify(oBody)
            });
            let oRes = await call();
            if (oRes.status === 403 && oRes.headers.get("X-CSRF-Token") === "Required") {
                this._sCsrf = null;
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

        _isForbidden(oError) {
            return !!oError && (oError.status === 403 || oError.status === 401);
        },

        _fail(oError) {
            if (this._isForbidden(oError)) {
                this._oUi.setProperty("/forbidden", true);
                MessageBox.error(this._t("errNoRole"));
            } else {
                MessageBox.error((oError && oError.message) || this._t("errGeneric"));
            }
        },

        _refreshTable() {
            const oBinding = this.byId("handoffTable").getBinding("items");
            if (oBinding) { oBinding.refresh(); }
        },

        // days since the last change (for an approved requisition this is the approval day)
        _age(oRow) {
            return Math.floor((Date.now() - new Date(oRow.modifiedAt || oRow.createdAt).getTime()) / DAY);
        },

        // ------------------------------------------------------------------
        // navigation
        // ------------------------------------------------------------------
        _goto(sKey) {
            this._oUi.setProperty("/page", sKey);
            this.byId("nav").to(this.byId(PAGES[sKey]).getId(), "show");
            if (sKey === "dashboard") {
                this._updateGreeting();
                this._loadDashboard();
            }
        },

        onToggleSide() {
            this._oUi.setProperty("/sideExpanded", !this._oUi.getProperty("/sideExpanded"));
        },

        onNavSelect(oEvent) {
            const sKey = oEvent.getParameter("item").getKey();
            if (sKey === "dashboard") { this._goto("dashboard"); }
            else if (sKey === "failed") { this._openQueue("Failed"); }
            else if (sKey === "published") { this._openQueue("Published"); }
            else { this._openQueue("Approved"); }
        },

        onShowAlerts() {
            this._goto("dashboard");
        },

        _openQueue(sFilter) {
            this._oUi.setProperty("/stateFilter", sFilter);
            this._applyFilters();
            this._goto("queue");
            this._oUi.setProperty("/page", MENU[sFilter] || "queue");   // highlight the matching menu entry
        },

        // KPI tiles: each tile carries the queue filter it opens
        onTilePress(oEvent) {
            this._openQueue(oEvent.getSource().data("filter") || "Approved");
        },

        // quick action cards
        onOpenReady() { this._openQueue("Approved"); },
        onOpenFailed() { this._openQueue("Failed"); },
        onOpenPublished() { this._openQueue("Published"); },

        onRefreshAll() {
            this._refreshTable();
            this._loadDashboard();
        },

        // ------------------------------------------------------------------
        // dashboard: load, KPIs, alerts, charts
        // ------------------------------------------------------------------
        async _loadDashboard() {
            const sQuery = "Requisitions?$select=ID,reqNumber,title,requester,status,totalAmount,currency_code,costCentre_code,createdAt,modifiedAt" +
                "&$filter=status eq 'Approved' or status eq 'Published' or status eq 'Failed'" +
                "&$expand=erpReference($select=poNumber,publicationStatus,attempts,lastError,lastAttemptAt,publishedAt)" +
                "&$orderby=modifiedAt desc&$top=1000";
            try {
                const oRes = await this._send("GET", sQuery);
                this._aRows = (oRes && oRes.value) || [];
                this._oUi.setProperty("/forbidden", false);
                this._buildDashboard();
            } catch (oError) {
                if (this._isForbidden(oError)) { this._oUi.setProperty("/forbidden", true); }
                else { MessageToast.show(oError.message); }
            }
        },

        // value tile: the largest currency, scaled (23.79 K), other currencies noted in the footer
        _valueInfo(aList) {
            const mSum = {};
            aList.forEach(r => {
                const sCur = r.currency_code || "-";
                mSum[sCur] = (mSum[sCur] || 0) + (Number(r.totalAmount) || 0);
            });
            const aEntries = Object.entries(mSum).sort((a, b) => b[1] - a[1]);
            if (!aEntries.length) { return { num: "0.00", scale: "", foot: "" }; }
            const [sCur, nVal] = aEntries[0];
            const sScale = nVal >= 1e6 ? "M" : nVal >= 1e3 ? "K" : "";
            const nShown = sScale === "M" ? nVal / 1e6 : sScale === "K" ? nVal / 1e3 : nVal;
            return {
                num: nShown.toFixed(2),
                scale: sScale,
                foot: aEntries.length > 1 ? this._t("valueMore", [sCur, aEntries.length - 1]) : sCur
            };
        },

        _buildDashboard() {
            const a = this._aRows;
            const aReady = a.filter(r => r.status === "Approved");
            const aFailed = a.filter(r => r.status === "Failed");
            const aAlerts = this._buildAlerts(aReady, aFailed);
            const oVal = this._valueInfo(aReady);

            this._oDash.setData({
                ready: aReady.length,
                failed: aFailed.length,
                published: a.filter(r => r.status === "Published").length,
                total: a.length,
                valueNum: oVal.num,
                valueScale: oVal.scale,
                valueFoot: oVal.foot,
                alertCount: aAlerts.length,
                alertFilter: aFailed.length ? "Failed" : "Approved",
                alerts: aAlerts
            });
            this._oUi.setProperty("/alertBadge", aAlerts.length ? String(aAlerts.length) : "");
            this._renderCharts();
        },

        // alerts: failed hand-offs and approved requisitions that wait too long
        // (they feed the "Open alerts" tile, the bell badge and the assistant)
        _buildAlerts(aReady, aFailed) {
            const aOut = [];
            aFailed.forEach(r => {
                const oRef = r.erpReference || {};
                const nTries = Number(oRef.attempts) || 0;
                const sError = shorten(oRef.lastError);
                aOut.push({
                    id: r.ID, severity: 0, type: "Error",
                    text: nTries >= 3
                        ? this._t("alFailedRepeat", [r.reqNumber, nTries, sError])
                        : this._t("alFailed", [r.reqNumber, nTries, sError])
                });
            });
            aReady.forEach(r => {
                const d = this._age(r);
                if (d > 5) {
                    aOut.push({ id: r.ID, severity: 1, type: "Error", text: this._t("alWaitingLong", [r.reqNumber, d]) });
                } else if (d > 2) {
                    aOut.push({ id: r.ID, severity: 2, type: "Warning", text: this._t("alWaiting", [r.reqNumber, d]) });
                }
            });
            return aOut.sort((x, y) => x.severity - y.severity);
        },

        // ---- charts: plain SVG; chart colours are set here, fonts and text come from the SAP theme ----
        _renderCharts() {
            const oStatus = this.byId("chartStatus");
            const oMonths = this.byId("chartMonths");
            if (oStatus) {
                oStatus.setContent(this._statusDonut());
                this._attachStatusClick(oStatus);
            }
            if (oMonths) { oMonths.setContent(this._monthBars()); }
        },

        // clicking a segment or a legend entry opens the queue filtered by that status
        _attachStatusClick(oHtml) {
            if (this._bStatusClick) { return; }           // add the delegate only once
            this._bStatusClick = true;
            oHtml.addEventDelegate({
                onAfterRendering: () => {
                    const oDom = oHtml.getDomRef();
                    if (!oDom) { return; }
                    oDom.querySelectorAll("[data-status]").forEach(el => {
                        el.addEventListener("click", () =>
                            this._openQueue(el.getAttribute("data-status")));
                    });
                }
            });
        },

        // status ring: amber = ready, rose = failed, emerald = published
        _statusDonut() {
            const a = this._aRows;
            const TEXT = "fill:var(--sapTextColor)";
            const MUTED = "fill:var(--sapContent_LabelColor)";
            const aParts = [
                { key: "Approved", label: this._t("chReady"), color: "#f59e0b" },
                { key: "Failed", label: this._t("chFailed"), color: "#f43f5e" },
                { key: "Published", label: this._t("chPublished"), color: "#FF00FF" }
            ].map(p => ({ ...p, n: a.filter(r => r.status === p.key).length }));

            const nTotal = aParts.reduce((s, p) => s + p.n, 0);
            const nShown = aParts.filter(p => p.n > 0).length;
            const R = 70, C = 2 * Math.PI * R;
            const nGap = nShown > 1 ? 3 : 0;               // small gap between segments

            let s = `<div class="prChart"><svg viewBox="0 0 420 190" width="100%" height="190" role="img" aria-label="${esc(this._t("chStatusTitle"))}">`;
            s += `<circle cx="95" cy="95" r="${R}" fill="none" stroke-width="26" style="stroke:var(--sapList_BorderColor)"/>`;

            let nOffset = 0;
            aParts.forEach(p => {
                if (!p.n || !nTotal) { return; }
                const nLen = C * p.n / nTotal;
                const nDash = Math.max(nLen - nGap, 0.1);
                s += `<circle data-status="${p.key}" cx="95" cy="95" r="${R}" fill="none" stroke-width="26" stroke="${p.color}" ` +
                    `stroke-dasharray="${nDash} ${C - nDash}" stroke-dashoffset="${-nOffset}" transform="rotate(-90 95 95)">` +
                    `<title>${esc(p.label)}: ${p.n}</title></circle>`;
                nOffset += nLen;
            });

            s += `<text x="95" y="98" text-anchor="middle" font-size="30" font-weight="700" style="${TEXT}">${nTotal}</text>`;
            s += `<text x="95" y="118" text-anchor="middle" font-size="12" style="${MUTED}">${esc(this._t("chRequisitions"))}</text>`;

            aParts.forEach((p, i) => {
                const y = 40 + i * 28;
                s += `<g data-status="${p.key}">` +
                    `<rect x="190" y="${y - 7}" width="220" height="26" fill="transparent"/>` +
                    `<rect x="200" y="${y}" width="12" height="12" rx="3" fill="${p.color}"/>` +
                    `<text x="220" y="${y + 11}" font-size="13" style="${TEXT}">${esc(p.label)}  ·  ${p.n}</text>` +
                    `<title>${esc(p.label)}: ${p.n}</title></g>`;
            });
            return s + "</svg></div>";
        },

        // purchase orders created per month, last 6 months (one soft gradient colour per month)
        _monthBars() {
            const TEXT = "fill:var(--sapTextColor)";
            const MUTED = "fill:var(--sapContent_LabelColor)";
            const COLORS = ["#8b5cf6", "#ec4899", "#f59e0b", "#14b8a6", "#38bdf8", "#f97316"];
            const aMonths = [];
            const oNow = new Date();
            for (let i = 5; i >= 0; i--) {
                const d = new Date(oNow.getFullYear(), oNow.getMonth() - i, 1);
                aMonths.push({
                    key: `${d.getFullYear()}-${d.getMonth()}`,
                    label: d.toLocaleString(undefined, { month: "short" }), value: 0
                });
            }
            this._aRows.filter(r => r.status === "Published").forEach(r => {
                const d = new Date((r.erpReference && r.erpReference.publishedAt) || r.modifiedAt);
                const m = aMonths.find(x => x.key === `${d.getFullYear()}-${d.getMonth()}`);
                if (m) { m.value += 1; }
            });

            const W = 420, H = 190, base = 150, maxH = 110, bw = 28;
            const nMax = Math.max(1, ...aMonths.map(m => m.value));
            const nSlot = W / aMonths.length;

            let s = `<div class="prChart"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(this._t("chMonthsTitle"))}">`;
            s += "<defs>" + COLORS.map((c, i) =>
                `<linearGradient id="prBar${i}" x1="0" y1="0" x2="0" y2="1">` +
                `<stop offset="0%" stop-color="${c}" stop-opacity="0.55"/>` +
                `<stop offset="100%" stop-color="${c}" stop-opacity="1"/></linearGradient>`).join("") + "</defs>";

            aMonths.forEach((m, i) => {
                const h = m.value ? Math.max(bw, Math.round(maxH * m.value / nMax)) : 0;
                const x = i * nSlot + (nSlot - bw) / 2;
                s += `<rect x="${x}" y="${base - maxH}" width="${bw}" height="${maxH}" rx="${bw / 2}" fill="#f1f1fb"/>`;
                if (h) {
                    s += `<rect x="${x}" y="${base - h}" width="${bw}" height="${h}" rx="${bw / 2}" fill="url(#prBar${i % COLORS.length})">` +
                        `<title>${esc(m.label)}: ${m.value}</title></rect>`;
                }
                s += `<text x="${x + bw / 2}" y="${base - maxH - 6}" text-anchor="middle" font-size="12" style="${TEXT}">${m.value}</text>`;
                s += `<text x="${x + bw / 2}" y="${base + 20}" text-anchor="middle" font-size="12" style="${MUTED}">${esc(m.label)}</text>`;
            });
            return s + "</svg></div>";
        },

        // ------------------------------------------------------------------
        // queue: filters and events
        // ------------------------------------------------------------------
        onUpdateFinished(oEvent) {
            this._oUi.setProperty("/count", oEvent.getParameter("total") || 0);
        },

        onFilterChange() {
            const sFilter = this._oUi.getProperty("/stateFilter");
            this._oUi.setProperty("/page", MENU[sFilter] || "queue");
            this._applyFilters();
        },

        onSearch(oEvent) {
            this._oUi.setProperty("/search", (oEvent.getParameter("query") || "").trim());
            this._applyFilters();
        },

        onDateChange(oEvent) {
            this._oUi.setProperty("/dateFrom", oEvent.getSource().getDateValue() || null);
            this._oUi.setProperty("/dateTo", oEvent.getSource().getSecondDateValue() || null);
            this._applyFilters();
        },

        // every group is one multi-filter, so groups are ANDed and the filters inside a group keep their own and/or
        _applyFilters() {
            const { stateFilter, search, dateFrom, dateTo } = this._oUi.getData();
            const aStatuses = stateFilter && stateFilter !== "All" ? [stateFilter] : ALL_STATUSES;
            const aFilters = [new Filter({
                filters: aStatuses.map(s => new Filter("status", FilterOperator.EQ, s)),
                and: false
            })];

            if (search) {
                aFilters.push(new Filter({
                    filters: [
                        new Filter("reqNumber", FilterOperator.Contains, search),
                        new Filter("title", FilterOperator.Contains, search),
                        new Filter("requester", FilterOperator.Contains, search)
                    ],
                    and: false
                }));
            }
            if (dateFrom || dateTo) {
                const aRange = [];
                if (dateFrom) { aRange.push(new Filter("modifiedAt", FilterOperator.GE, dateFrom.toISOString())); }
                if (dateTo) {
                    const oEnd = new Date(dateTo);
                    oEnd.setHours(23, 59, 59, 999);
                    aRange.push(new Filter("modifiedAt", FilterOperator.LE, oEnd.toISOString()));
                }
                aFilters.push(new Filter({ filters: aRange, and: true }));
            }
            const oBinding = this.byId("handoffTable").getBinding("items");
            if (oBinding) { oBinding.filter(aFilters); }
        },

        onRefresh() {
            this._refreshTable();
        },

        // ------------------------------------------------------------------
        // details dialog
        // ------------------------------------------------------------------
        onRowPress(oEvent) {
            this._openDetails(oEvent.getSource().getBindingContext().getProperty("ID"));
        },

        _openDetails(sId) {
            const oDialog = this._dlg("detailDialog");
            if (!oDialog) { return; }
            oDialog.bindElement({
                path: `/Requisitions(${sId})`,
                parameters: {
                    $expand: {
                        items: { $orderby: "itemNo" },
                        decisions: { $orderby: "decidedAt desc" },
                        erpReference: {}
                    }
                }
            });
            oDialog.open();
        },

        onCloseDetails() {
            const oDialog = this._dlg("detailDialog");
            if (!oDialog) { return; }
            oDialog.close();
            oDialog.unbindElement();
        },

        // ------------------------------------------------------------------
        // release and retry (row buttons and details dialog)
        // ------------------------------------------------------------------
        onRelease(oEvent) {
            const oCtx = oEvent.getSource().getBindingContext();
            this._confirmAction("release", oCtx.getProperty("ID"), oCtx.getProperty("reqNumber"), 0, "");
        },

        onRetry(oEvent) {
            const oCtx = oEvent.getSource().getBindingContext();
            this._confirmAction("retryHandoff", oCtx.getProperty("ID"), oCtx.getProperty("reqNumber"),
                oCtx.getProperty("erpReference/attempts") || 0,
                oCtx.getProperty("erpReference/lastError") || "");
        },

        _confirmAction(sAction, sId, sNo, nAttempts, sError) {
            const sText = sAction === "release"
                ? this._t("confirmRelease", [sNo])
                : this._t("confirmRetry", [sNo, nAttempts, shorten(sError, 160)]);
            MessageBox.confirm(sText, {
                actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
                emphasizedAction: MessageBox.Action.OK,
                onClose: sBtn => { if (sBtn === MessageBox.Action.OK) { this._execute(sAction, sId, sNo); } }
            });
        },

        // the backend checks: Procurement role, status Approved (release) or Failed (retry), same idempotency key on retry
        async _execute(sAction, sId, sNo) {
            try {
                await this._busy(() => this._send("POST",
                    `Requisitions(${sId})/RequisitionService.${sAction}`, {}));
            } catch (oError) {
                this._fail(oError);
                return { ok: false, text: oError.message };
            }

            // the hand-off may have failed on the ERP side: the backend keeps the requisition and reports a warning
            let oRes = null;
            try {
                oRes = await this._send("GET",
                    `Requisitions(${sId})?$select=status&$expand=erpReference($select=poNumber,lastError,attempts)`);
            } catch (e) { /* the list refresh below shows the result anyway */ }

            const oDetails = this.byId("detailDialog");
            if (oDetails && oDetails.isOpen()) { oDetails.close(); oDetails.unbindElement(); }
            this._refreshTable();
            this._loadDashboard();

            const oRef = (oRes && oRes.erpReference) || {};
            if (oRes && oRes.status === "Failed") {
                MessageBox.warning(this._t("warnFailed", [sNo, oRef.lastError || ""]));
                return { ok: false, text: oRef.lastError || "" };
            }
            MessageToast.show(this._t("okPublished", [sNo, oRef.poNumber || "-"]));
            return { ok: true, po: oRef.poNumber || "" };
        },

        // ------------------------------------------------------------------
        // assistant: answers from the loaded data, prepares actions, you confirm
        // ------------------------------------------------------------------
        onToggleChat() {
            this._oChat.setProperty("/open", !this._oChat.getProperty("/open"));
        },

        onChip(oEvent) {
            this._ask(oEvent.getSource().getText());
        },

        onChatSend() {
            const oInput = this.byId("chatInput");
            const sText = ((oInput && oInput.getValue()) || "").trim();
            if (!sText) { return; }
            oInput.setValue("");
            this._oChat.setProperty("/input", "");
            this._ask(sText);
        },

        _ask(sText) {
            this._pushMsg("user", sText);
            const oReply = this._answer(sText);
            this._pushMsg("bot", oReply.text, oReply.action);
        },

        _pushMsg(sRole, sText, oAction) {
            const aMsgs = this._oChat.getProperty("/messages").slice();
            aMsgs.push({ role: sRole, text: sText, action: oAction || null, pending: !!oAction });
            this._oChat.setProperty("/messages", aMsgs);
            setTimeout(() => {
                const oScroll = this.byId("chatScroll");
                if (oScroll) { oScroll.scrollTo(0, 100000, 200); }
            }, 80);
        },

        _line(r) {
            const oRef = r.erpReference || {};
            const sPo = oRef.poNumber ? `, PO ${oRef.poNumber}` : "";
            return `• ${r.reqNumber} - ${r.title} (${r.requester}, ${r.currency_code || ""} ${AMOUNT.format(Number(r.totalAmount) || 0)}${sPo})`;
        },

        _lines(aList, iMax = 5) {
            const aShown = aList.slice(0, iMax).map(r => this._line(r));
            if (aList.length > iMax) { aShown.push(this._t("aiMore", [aList.length - iMax])); }
            return aShown.join("\n");
        },

        _answer(sRaw) {
            const s = sRaw.toLowerCase();
            const a = this._aRows;
            const by = sStatus => a.filter(r => r.status === sStatus);
            const oNo = /pr-\d{4}-\d{3,4}/i.exec(sRaw);
            const sNo = oNo ? oNo[0].toUpperCase() : "";
            const oRow = sNo ? a.find(r => (r.reqNumber || "").toUpperCase() === sNo) : null;

            // actions: prepared here, executed only after the user confirms
            if (/^\s*release\b/.test(s)) {
                if (!sNo) { return { text: this._t("aiNeedNumber") }; }
                if (!oRow) { return { text: this._t("aiNotFound", [sNo]) }; }
                if (oRow.status !== "Approved") { return { text: this._t("aiCannotRelease", [sNo, oRow.status]) }; }
                return { text: this._t("aiConfirmRelease", [sNo]), action: { type: "release", id: oRow.ID, no: sNo } };
            }
            if (/^\s*retry\b/.test(s)) {
                if (!sNo) { return { text: this._t("aiNeedNumber") }; }
                if (!oRow) { return { text: this._t("aiNotFound", [sNo]) }; }
                if (oRow.status !== "Failed") { return { text: this._t("aiCannotRetry", [sNo, oRow.status]) }; }
                return { text: this._t("aiConfirmRetry", [sNo]), action: { type: "retryHandoff", id: oRow.ID, no: sNo } };
            }

            // one requisition
            if (sNo) {
                if (!oRow) { return { text: this._t("aiNotFound", [sNo]) }; }
                if (/(open|show|detail)/.test(s)) { this._openDetails(oRow.ID); }
                const oRef = oRow.erpReference || {};
                return {
                    text: this._t("aiRow", [oRow.reqNumber, oRow.title, oRow.status,
                    oRef.poNumber || "-", oRef.attempts || 0, shorten(oRef.lastError || "-", 120)])
                };
            }

            // overviews
            if (/(attention|alert|urgent|today|overdue|late)/.test(s)) {
                const aAlerts = this._oDash.getProperty("/alerts");
                return aAlerts.length
                    ? {
                        text: this._t("aiAttention", [aAlerts.length]) + "\n" +
                            aAlerts.slice(0, 5).map(x => "• " + x.text).join("\n")
                    }
                    : { text: this._t("aiNoAlerts") };
            }
            if (/(fail|error|retry)/.test(s)) {
                const aList = by("Failed");
                return { text: aList.length ? this._t("aiFailedList", [aList.length]) + "\n" + this._lines(aList) : this._t("aiNoneFailed") };
            }
            if (/(publish|purchase order|\bpo\b)/.test(s)) {
                const aList = by("Published");
                return { text: aList.length ? this._t("aiPublishedList", [aList.length]) + "\n" + this._lines(aList) : this._t("aiNonePublished") };
            }
            if (/(ready|release|waiting|approved|open|queue)/.test(s)) {
                const aList = by("Approved");
                return { text: aList.length ? this._t("aiReadyList", [aList.length]) + "\n" + this._lines(aList) : this._t("aiNoneReady") };
            }
            if (/(value|spend|amount|cost cent)/.test(s)) {
                const m = {};
                by("Approved").forEach(r => {
                    const sKey = `${r.costCentre_code || "-"} (${r.currency_code || "-"})`;
                    m[sKey] = (m[sKey] || 0) + (Number(r.totalAmount) || 0);
                });
                const aRows = Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, 5);
                return {
                    text: aRows.length
                        ? this._t("aiValue") + "\n" + aRows.map(([k, v]) => `• ${k}: ${AMOUNT.format(v)}`).join("\n")
                        : this._t("aiNoValue")
                };
            }
            if (/(how many|count|summary|overview|total|status)/.test(s)) {
                const d = this._oDash.getData();
                return { text: this._t("aiSummary", [d.total, d.ready, d.failed, d.published]) };
            }
            return { text: this._t("aiFallback") };
        },

        async onChatConfirm(oEvent) {
            const sPath = oEvent.getSource().getBindingContext("chat").getPath();
            const oAction = this._oChat.getProperty(sPath).action;
            this._oChat.setProperty(`${sPath}/pending`, false);
            const oResult = await this._execute(oAction.type, oAction.id, oAction.no);
            this._pushMsg("bot", oResult.ok
                ? this._t(oAction.type === "release" ? "aiDoneRelease" : "aiDoneRetry", [oAction.no, oResult.po || "-"])
                : this._t("aiFailed", [oResult.text || ""]));
        },

        onChatDismiss(oEvent) {
            const sPath = oEvent.getSource().getBindingContext("chat").getPath();
            this._oChat.setProperty(`${sPath}/pending`, false);
            this._pushMsg("bot", this._t("aiDismissed"));
        }
    });
});