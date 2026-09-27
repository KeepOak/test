package com.keepoak.branchagent;

import android.content.ComponentName;
import android.content.Context;

/** Manifest class names follow the namespace; the owning application may have a test suffix. */
final class BranchComponents {
    private BranchComponents() {}

    static String className(String relativeName) {
        return BranchComponents.class.getPackage().getName() + relativeName;
    }

    static ComponentName component(Context context, String relativeName) {
        return new ComponentName(context, className(relativeName));
    }
}
