import Link from "next/link";
import { SUPPORT_EMAIL, SUPPORT_MAILTO_URL } from "@/lib/support";

export const metadata = {
  title: "Terms of Service — Schedule FlowTrack",
  description: "Terms of Service for ScheduleFlowTrack, provided by Nova Labs Digital LLC.",
};

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <nav className="border-b border-slate-200 bg-white">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-[#0f172a] text-white text-xs font-bold">
              FTS
            </div>
            <span className="text-sm font-semibold text-slate-900">Schedule FlowTrack</span>
          </Link>
          <Link href="/login" className="text-xs text-slate-500 hover:text-slate-700 transition-colors">
            ← Back to Login
          </Link>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-2xl font-bold text-slate-900">ScheduleFlowTrack Terms of Service</h1>
        <p className="mt-2 text-sm text-slate-500">Effective Date: July 26, 2026</p>

        <div className="mt-8 space-y-8 text-sm leading-relaxed text-slate-700">
          <section>
            <h2 className="text-base font-semibold text-slate-900">1. Acceptance of Terms</h2>
            <p className="mt-2">
              These Terms of Service (&quot;Terms&quot;) govern your access to and use of ScheduleFlowTrack (the
              &quot;Service&quot;), provided by Nova Labs Digital LLC (&quot;Nova Labs Digital,&quot; &quot;we,&quot;
              &quot;us,&quot; or &quot;our&quot;). By creating an account, logging in, or otherwise using the Service, you
              agree to be bound by these Terms. If you do not agree, do not use the Service.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">2. Eligibility and Authority to Use the Service for a Business</h2>
            <p className="mt-2">
              ScheduleFlowTrack is intended for use by business owners and their authorized employees to manage
              appointments, clients, and scheduling operations. By using the Service on behalf of a business, you
              represent that you are authorized to act on that business&apos;s behalf and to bind it to these Terms.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">3. Description of ScheduleFlowTrack</h2>
            <p className="mt-2">
              ScheduleFlowTrack is appointment and scheduling management software for service businesses. It provides
              tools for managing clients, appointments, services, staff, and related communication preferences.
              ScheduleFlowTrack is one product offered by Nova Labs Digital LLC.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">4. Account and Credential Responsibility</h2>
            <p className="mt-2">
              You are responsible for maintaining the confidentiality of your account credentials and for all
              activity that occurs under your account, including activity by employees you grant access to. Notify us
              promptly at{" "}
              <a href={SUPPORT_MAILTO_URL} className="text-blue-700 hover:underline">
                {SUPPORT_EMAIL}
              </a>{" "}
              if you believe your account has been accessed without authorization.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">5. Customer Responsibility for Information Entered into the Service</h2>
            <p className="mt-2">
              You are solely responsible for the accuracy, legality, and appropriateness of all information you or
              your employees enter into the Service, including company information, service descriptions, scheduling
              details, and any notes recorded within the Service.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">6. Client and Employee Information Uploaded by Subscribing Businesses</h2>
            <p className="mt-2">
              As a subscribing business, you may enter information about your own clients and employees into the
              Service, such as names, contact details, appointment history, and scheduling or job-tracking notes. You
              are responsible for having the legal right to collect, store, and process that information, and for
              complying with any applicable laws governing your relationship with your clients and employees. Nova
              Labs Digital LLC processes this information on your behalf as part of operating the Service.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">7. Lawful Use</h2>
            <p className="mt-2">
              You agree to use the Service only for lawful business purposes and in compliance with all applicable
              laws and regulations, including those governing consumer protection, data privacy, and electronic
              communications.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">8. Email and SMS Communications</h2>
            <p className="mt-2">
              The Service allows subscribing businesses to send appointment-related email and SMS messages to their
              own clients. These messages are delivered using third-party communication providers. Delivery is not
              guaranteed and may be affected by recipient carriers, invalid or outdated contact information,
              recipient consent status, or third-party provider availability.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">9. Consent Required Before Messaging Clients or Employees</h2>
            <p className="mt-2">
              Before using the Service to send email or SMS messages to any client or employee, you are responsible
              for obtaining any consent required by applicable law, including consent required under laws governing
              unsolicited electronic communications and text messaging.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">10. Customer Responsibility for Message Content, Recipients, and Preferences</h2>
            <p className="mt-2">
              You are solely responsible for the content of messages sent through the Service, the accuracy of
              recipient contact information you enter, and honoring the communication preferences and opt-out
              requests of your own clients and employees.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">11. Third-Party Services</h2>
            <p className="mt-2">
              The Service relies on third-party providers to operate, including payment processing, hosting and
              database infrastructure, and email and SMS delivery. Your use of the Service is also subject to the
              availability and performance of these third-party providers, which are outside our control.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">12. Free Trial</h2>
            <p className="mt-2">
              ScheduleFlowTrack Pro includes a 30-day free trial. A payment method is collected when you sign up, and
              you receive full Pro access during the trial. If you cancel during the trial, no subscription charge
              will occur, and your access ends immediately — trial cancellation does not include the 30-day
              read-only period described in Section 16. If you do not cancel, billing begins automatically at $24.99
              USD per month once the trial ends.
            </p>
            <p className="mt-2">
              The 30-day free trial is available once per customer business. It belongs to your business account, not
              to any individual person, email address, or browser. If your business has already started or used a
              trial, that business is not eligible for another free trial. A returning or reactivating customer may
              resubscribe at any time, but billing begins immediately at $24.99 USD per month — no additional trial
              period is applied.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">13. Subscription Price and Monthly Billing</h2>
            <p className="mt-2">
              After the free trial, ScheduleFlowTrack is billed at $24.99 USD per month, billed on a recurring
              monthly basis. No annual plan is currently offered. Pricing is subject to change on a prospective basis
              with reasonable notice.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">14. Automatic Renewal</h2>
            <p className="mt-2">
              Your subscription automatically renews each month unless cancelled before the end of the current
              billing period. By subscribing, you authorize Nova Labs Digital LLC to charge your payment method on
              each renewal date.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">15. Cancellation</h2>
            <p className="mt-2">
              You may cancel at any time. If you are on a paid subscription, cancellation takes effect at the end of
              your current paid billing period, and you will continue to have access to the Service through the end
              of that period; see Section 16 for what happens next. If you are still within your free trial, see
              Section 12 above — cancellation takes effect immediately, and you do not receive the read-only period
              described in Section 16.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">16. Read-Only Access and Data After Cancellation</h2>
            <p className="mt-2">
              After access under an eligible paid subscription ends (Section 15), you (the business owner) receive
              30 calendar days of read-only access. During this period you can log in, view your existing business
              data, and use any export or copy capability the Service makes available at that time — but you cannot
              create, edit, delete, schedule, reschedule, or send messages, and scheduled reminder notifications are
              turned off. If you cancel during your free trial instead (Section 12), you do not receive this
              read-only period — your access, and scheduled reminder notifications, end immediately. Employees lose
              access as soon as your trial or paid access ends — employees do not receive this read-only period,
              regardless of how your access ended.
            </p>
            <p className="mt-2">
              After the 30-day read-only period — or immediately, if your free trial was canceled — operational
              access to the Service is locked. You will still be able to log in and reach billing so you can
              reactivate. Reactivating your subscription restores full access with your existing business data
              intact — nothing is deleted, altered, or lost during the read-only or locked periods — and does not
              grant another free trial (Section 12).
            </p>
            <p className="mt-2">
              We do not promise that your data will be retained indefinitely. Any future deletion of a long-inactive,
              non-paying account is governed by our Privacy Policy and will only occur consistent with applicable
              law.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">17. Refunds</h2>
            <p className="mt-2">
              Payments already processed are non-refundable, except where required by applicable law or where Nova
              Labs Digital LLC, in its discretion, approves an exception.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">18. Taxes</h2>
            <p className="mt-2">
              Subscription fees do not include any applicable taxes. If we are required to collect taxes on your
              subscription, such taxes will be added to your billed amount as required by law.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">19. Service Availability and Changes</h2>
            <p className="mt-2">
              We work to keep the Service available and reliable, but we do not guarantee uninterrupted or error-free
              operation. We may modify, update, or discontinue features of the Service from time to time.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">20. Data and Account Termination</h2>
            <p className="mt-2">
              We may suspend or terminate your access to the Service for violation of these Terms, non-payment, or
              other conduct that we determine, in good faith, to be harmful to the Service or its users. Upon
              termination, your right to use the Service ends, subject to the data-retention practices described in
              Section 16 above and in our Privacy Policy.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">21. Intellectual Property</h2>
            <p className="mt-2">
              The Service, including its software, design, and branding, is owned by Nova Labs Digital LLC and is
              protected by applicable intellectual property laws. These Terms do not grant you any ownership interest
              in the Service. You retain ownership of the business data you enter into the Service.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">22. Prohibited Conduct</h2>
            <p className="mt-2">
              You agree not to misuse the Service, including by attempting to gain unauthorized access to accounts or
              data, interfering with the Service&apos;s operation, using the Service to send unlawful or unsolicited
              communications, or using the Service in a way that violates the rights of others.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">23. Warranty Disclaimer</h2>
            <p className="mt-2">
              THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE,&quot; WITHOUT WARRANTIES OF ANY KIND,
              WHETHER EXPRESS OR IMPLIED. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, SECURE, ERROR-FREE,
              OR THAT MESSAGES SENT THROUGH THE SERVICE WILL BE DELIVERED, OR THAT USE OF THE SERVICE WILL PRODUCE ANY
              PARTICULAR BUSINESS RESULT.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">24. Limitation of Liability</h2>
            <p className="mt-2">
              TO THE MAXIMUM EXTENT PERMITTED BY LAW, NOVA LABS DIGITAL LLC WILL NOT BE LIABLE FOR ANY INDIRECT,
              INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, DATA, OR BUSINESS,
              ARISING FROM YOUR USE OF THE SERVICE. OUR TOTAL LIABILITY FOR ANY CLAIM RELATING TO THE SERVICE WILL NOT
              EXCEED THE AMOUNT YOU PAID TO US FOR THE SERVICE IN THE THREE MONTHS BEFORE THE CLAIM AROSE.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">25. Indemnification</h2>
            <p className="mt-2">
              You agree to indemnify and hold Nova Labs Digital LLC harmless from claims, damages, or expenses arising
              from your misuse of the Service or your violation of applicable law, including claims arising from
              messages you send to your own clients or employees through the Service without proper consent.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">26. Governing Law</h2>
            <p className="mt-2">These Terms are governed by the laws of the State of Florida, United States, without regard to conflict-of-law principles.</p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">27. Changes to These Terms</h2>
            <p className="mt-2">
              We may update these Terms from time to time. If we make material changes, we will update the effective
              date above. Continued use of the Service after changes take effect constitutes acceptance of the
              updated Terms.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-slate-900">28. Contact Information</h2>
            <p className="mt-2">
              Questions about these Terms can be sent to{" "}
              <a href={SUPPORT_MAILTO_URL} className="text-blue-700 hover:underline">
                {SUPPORT_EMAIL}
              </a>
              .
            </p>
          </section>
        </div>

        <div className="mt-12 pt-6 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500">
          <Link href="/privacy" className="hover:text-slate-700 transition-colors">
            Privacy Policy
          </Link>
          <span>Powered by Nova Labs Digital</span>
        </div>
      </main>
    </div>
  );
}
