import type { PageLayout } from "./make-pdf.ts";

/** The routing and wording of the T210 appeal form: optional notes, "> go to Section n" and "> go to question n.m" options, and a margin note stating a format. */
export const ROUTED_FORM: PageLayout[] = [
  {
    texts: [
      { text: "Section 1 - Appeal information", x: 28, y: 770 },
      { text: "1.1 CICA reference number", x: 28, y: 745 },
      { text: "Note 1.1", x: 428, y: 745 },
      { text: "CICA reference numbers", x: 428, y: 727 },
      { text: "begin with the letter X or G.", x: 428, y: 713 },
      { text: "Section 2 - Your information", x: 28, y: 690 },
      { text: "2.5 Are you appealing on behalf of someone else?", x: 28, y: 665 },
      { text: "Yes I am appealing on behalf of a minor > go to Section 3", x: 77, y: 638 },
      { text: "Yes I am appealing following a bereavement > go to Section 4", x: 77, y: 608 },
      { text: "No > go to Section 5", x: 77, y: 578 },
      { text: "Section 3 - Appealing on behalf of a minor", x: 28, y: 540 },
      { text: "3.1 Details of minor", x: 28, y: 515 },
      { text: "First name", x: 57, y: 490 },
      { text: "3.2 County (optional)", x: 28, y: 430 },
      { text: "Section 4 - Appealing following a bereavement", x: 28, y: 360 },
      { text: "4.1 Details of someone with fatal injuries", x: 28, y: 335 },
      { text: "First name", x: 57, y: 310 },
      { text: "Section 5 - Appellant's representative information", x: 28, y: 240 },
      { text: "5.1 Do you have a representative?", x: 28, y: 215 },
      { text: "Yes > go to question 5.2", x: 77, y: 188 },
      { text: "No > go to Section 6", x: 77, y: 158 }
    ],
    textBoxes: [
      { name: "ref", x: 57, y: 715 },
      { name: "minor", x: 57, y: 460 },
      { name: "county", x: 57, y: 400 },
      { name: "deceased", x: 57, y: 280 }
    ],
    checkboxes: [
      { name: "minorBox", x: 57, y: 635 },
      { name: "bereavedBox", x: 57, y: 605 },
      { name: "noBox", x: 57, y: 575 },
      { name: "yesRep", x: 57, y: 185 },
      { name: "noRep", x: 57, y: 155 }
    ]
  },
  {
    texts: [
      { text: "5.2 Details of appellant's representative", x: 28, y: 740 },
      { text: "First name", x: 57, y: 715 },
      { text: "5.4 Reference number for correspondence (optional)", x: 28, y: 640 },
      { text: "Section 6 - Reasons for appealing", x: 28, y: 560 },
      { text: "6.1 What are your reasons for appealing?", x: 28, y: 535 },
      { text: "9.2 Crime reference number (if known)", x: 28, y: 460 }
    ],
    textBoxes: [
      { name: "repName", x: 57, y: 685 },
      { name: "repRef", x: 57, y: 610 },
      { name: "reasons", x: 57, y: 505 },
      { name: "crime", x: 57, y: 430 }
    ]
  }
];
