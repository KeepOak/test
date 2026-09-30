package com.keepoak.branchagent;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import org.junit.Test;

public class BranchComponentsTest {
    @Test
    public void testApplicationSuffixDoesNotChangeTheManifestAliasClass() {
        String applicationId = "com.keepoak.branchagent.test";
        String alias = BranchComponents.className(".ShareTarget");
        assertEquals("com.keepoak.branchagent.ShareTarget", alias);
        assertNotEquals(applicationId + ".ShareTarget", alias);
    }

    @Test
    public void releaseApplicationResolvesTheSameAlias() {
        assertEquals("com.keepoak.branchagent.ShareTarget", BranchComponents.className(".ShareTarget"));
        assertEquals("com.keepoak.branchagent.MainActivity", BranchComponents.className(".MainActivity"));
    }
}
