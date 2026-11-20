/** Rows copied from hmcts/et-ccd-definitions-englandwales, trimmed to the columns and events the tests use. */
export const ET_SHEETS = {
  CaseType: [
    {
      ID: "ET_EnglandWales",
      Name: "Eng/Wales - Singles",
      JurisdictionID: "EMPLOYMENT"
    }
  ],
  State: [
    {
      CaseTypeID: "ET_EnglandWales",
      ID: "Submitted",
      Name: "Submitted"
    },
    {
      CaseTypeID: "ET_EnglandWales",
      ID: "AWAITING_SUBMISSION_TO_HMCTS",
      Name: "Awaiting Submission to HMCTS"
    },
    {
      CaseTypeID: "ET_EnglandWales",
      ID: "Vetted",
      Name: "Vetted"
    },
    {
      CaseTypeID: "ET_EnglandWales",
      ID: "Accepted",
      Name: "Accepted"
    },
    {
      CaseTypeID: "ET_EnglandWales",
      ID: "Closed",
      Name: "Closed"
    },
    {
      CaseTypeID: "ET_EnglandWales",
      ID: "Rejected",
      Name: "Rejected"
    },
    {
      CaseTypeID: "ET_EnglandWales",
      ID: "Transferred",
      Name: "Transferred"
    }
  ],
  CaseEvent: [
    {
      CaseTypeID: "ET_EnglandWales",
      ID: "disposeCase",
      Name: "Close Case",
      "PreConditionState(s)": "Accepted;Rejected",
      PostConditionState: "Closed",
      Publish: "Y"
    },
    {
      CaseTypeID: "ET_EnglandWales",
      ID: "SUBMIT_CASE_DRAFT",
      Name: "Submit Draft",
      "PreConditionState(s)": "AWAITING_SUBMISSION_TO_HMCTS",
      PostConditionState: "Submitted",
      Publish: "Y"
    },
    {
      CaseTypeID: "ET_EnglandWales",
      ID: "preAcceptanceCase",
      Name: "Accept/Reject Case",
      "PreConditionState(s)": "Accepted;Rejected;Vetted",
      PostConditionState: 'Accepted(preAcceptCase.caseAccepted="Yes"):1;Rejected',
      Publish: "Y"
    },
    {
      CaseTypeID: "ET_EnglandWales",
      ID: "createReferral",
      Name: "Create Referral",
      "PreConditionState(s)": "*",
      PostConditionState: "*",
      Publish: "Y"
    },
    {
      CaseTypeID: "ET_EnglandWales",
      ID: "replyToReferral",
      Name: "Reply to Referral",
      "PreConditionState(s)": "*",
      PostConditionState: "*",
      Publish: "Y"
    },
    {
      CaseTypeID: "ET_EnglandWales",
      ID: "initiateCase",
      Name: "Create Case",
      PostConditionState: "Submitted",
      Publish: "Y"
    },
    {
      CaseTypeID: "ET_EnglandWales",
      ID: "et1Vetting",
      Name: "ET1 case vetting",
      "PreConditionState(s)": "Submitted;Rejected;Vetted",
      PostConditionState: "Vetted"
    },
    {
      CaseTypeID: "ET_EnglandWales",
      ID: "caseTransferECM",
      Name: "Case Transfer to ECM",
      "PreConditionState(s)": "Submitted;AWAITING_SUBMISSION_TO_HMCTS;Vetted;Accepted;Closed;Rejected",
      PostConditionState: "Transferred"
    }
  ]
};
