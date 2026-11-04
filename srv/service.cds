using { pr } from '../db/schema';

service RequisitionService @(requires: 'authenticated-user') {
  @restrict: [
    { grant: ['READ','CREATE','UPDATE','DELETE'], to: 'Requester', where: 'requester = $user' },
    { grant: 'READ', to: ['Manager','Finance','Procurement','Admin'] },
    { grant: 'submitForApproval', to: 'Requester', where: 'requester = $user' },
    { grant: 'cancel',            to: 'Requester', where: 'requester = $user' },
    { grant: ['approve','reject','returnForCorrection'], to: ['Manager','Finance'] },
    { grant: ['release','retryHandoff'], to: 'Procurement' }
  ]
  @cds.redirection.target
  entity Requisitions as projection on pr.PurchaseRequisition actions {
    action submitForApproval()                    returns Requisitions;
    action approve(comment : String)              returns Requisitions;
    action reject(comment : String)               returns Requisitions;
    action returnForCorrection(comment : String)  returns Requisitions;
    action cancel(reason : String)                returns Requisitions;
    action release()                              returns Requisitions;
    action retryHandoff()                         returns Requisitions;
  };

  @restrict: [
    { grant: ['READ','CREATE','UPDATE','DELETE'], to: 'Requester' },
    { grant: 'READ', to: ['Manager','Finance','Procurement','Admin'] }
  ]
  entity RequisitionItems as projection on pr.RequisitionItem;

  @restrict: [
    { grant: ['READ','CREATE','UPDATE','DELETE'], to: 'Requester' },
    { grant: 'READ', to: ['Manager','Finance','Procurement','Admin'] }
  ]
  entity Attachments as projection on pr.Attachment;

  @restrict: [{ grant: 'READ', to: ['Requester','Manager','Finance','Procurement','Admin'] }]
  entity ApprovalDecisions as projection on pr.ApprovalDecision;

  @restrict: [{ grant: 'READ', to: ['Requester','Manager','Finance','Procurement','Admin'] }]
  @cds.redirection.target
  entity ApprovalTasks as projection on pr.ApprovalTask;

  @restrict: [{ grant: 'READ', to: ['Requester','Procurement','Admin'] }]
  entity ERPReferences as projection on pr.ERPReference;

  @restrict: [{ grant: 'READ', to: ['Requester','Manager','Finance','Procurement','Admin'] }]
  entity CostCentres as projection on pr.CostCentre;

  @restrict: [{ grant: 'READ', to: ['Requester','Manager','Finance','Procurement','Admin'] }]
  entity PurchaseCategories as projection on pr.PurchaseCategory;

  @restrict: [{ grant: 'READ', to: ['Manager','Finance'] }]
  entity MyTasks as projection on pr.ApprovalTask {
    *,
    requisition.reqNumber   as reqNumber,
    requisition.title       as title,
    requisition.requester   as requester,
    requisition.totalAmount as totalAmount,
    requisition.currency    as currency
  } where assignedTo = $user and state = 'Open';

  @restrict: [{ grant: 'READ', to: ['Procurement','Admin'] }]
  entity ProcurementQueue as projection on pr.PurchaseRequisition {
    key ID,
    reqNumber,
    title,
    requester,
    totalAmount,
    currency,
    status,
    erpReference.poNumber          as poNumber,
    erpReference.publicationStatus as publicationStatus,
    erpReference.attempts          as attempts,
    erpReference.lastError         as lastError
  } where status in ('Approved', 'Published', 'Failed');
}

service AdminService @(requires: 'Admin') {
  entity CostCentres        as projection on pr.CostCentre;
  entity PurchaseCategories as projection on pr.PurchaseCategory;
  entity ApprovalMatrix     as projection on pr.ApprovalMatrix;
}