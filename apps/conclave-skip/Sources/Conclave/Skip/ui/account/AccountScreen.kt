package conclave.module

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AccountScreen(
    account: AccountPresenter,
    onBack: () -> Unit,
    onOpenPrivacy: () -> Unit,
    modifier: Modifier = Modifier,
    onOpenSettings: (() -> Unit)? = null,
) {
    val snapshot = account.snapshot
    val scheme = MaterialTheme.colorScheme
    val snackbar = remember { SnackbarHostState() }
    var showDelete by remember { mutableStateOf(false) }
    val deletedText = conclaveString("pm_account_deleted")
    val deleteFailedText = conclaveString("pm_delete_failed")
    val retryText = conclaveString("pm_retry")
    val outcomeId = snapshot.outcomeId
    val outcome = snapshot.outcome
    LaunchedEffect(outcomeId) {
        if (outcomeId == 0 || !account.needsOutcomeNotice(id = outcomeId)) return@LaunchedEffect
        account.acknowledgeOutcome(id = outcomeId)
        when (outcome) {
            AccountOutcomeKind.deleted -> snackbar.showSnackbar(message = deletedText)
            AccountOutcomeKind.deleteFailed -> {
                val result = snackbar.showSnackbar(message = deleteFailedText, actionLabel = retryText,
                    duration = SnackbarDuration.Long)
                if (result == SnackbarResult.ActionPerformed) {
                    account.deleteAccount()
                }
            }
            AccountOutcomeKind.none -> Unit
        }
    }
    BackHandler(enabled = !snapshot.canDismiss) {
    }
    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        conclaveString(if (snapshot.isSignedIn) "pm_account" else "pm_sign_in"),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.semantics { heading() },
                    )
                },
                navigationIcon = {
                    ConclaveIconButton(conclaveString("ds_back"), ConclaveIcons.ArrowBackFill0, "account.back", onBack,
                        enabled = snapshot.canDismiss)
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = scheme.surface),
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
        containerColor = scheme.surface,
        contentWindowInsets = WindowInsets.safeDrawing,
    ) { padding ->
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            LazyColumn(
                modifier = Modifier.fillMaxSize().widthIn(max = 640.dp).testTag("account.list"),
                contentPadding = padding,
            ) {
                if (snapshot.context == AccountContext.signInRequired || snapshot.context == AccountContext.sessionExpired) {
                    item("context") { AccountContextBanner(snapshot.context) }
                }
                if (snapshot.isSignedIn) {
                    item("profile") { AccountProfileItem(snapshot) }
                    item("signOut") {
                        AccountActionItem(
                            title = conclaveString("pm_sign_out"),
                            identifier = "account.signOut",
                            pending = snapshot.isSigningOut,
                            enabled = !snapshot.isBusy,
                            onClick = { account.signOut() },
                        )
                    }
                    if (onOpenSettings != null) {
                        item("settings") {
                            AccountActionItem(
                                title = conclaveString("set_title"),
                                identifier = "account.settings",
                                pending = false,
                                enabled = snapshot.canDismiss,
                                onClick = onOpenSettings,
                            )
                        }
                    }
                    item("privacy") {
                        AccountActionItem(
                            title = conclaveString("pm_privacy_policy"),
                            identifier = "account.privacy",
                            pending = false,
                            enabled = snapshot.canDismiss,
                            onClick = onOpenPrivacy,
                        )
                    }
                    item("divider") { HorizontalDivider(color = scheme.outlineVariant) }
                    item("delete") {
                        AccountActionItem(
                            title = conclaveString("pm_delete_account"),
                            identifier = "account.delete",
                            pending = snapshot.isDeleting,
                            enabled = !snapshot.isBusy,
                            color = scheme.error,
                            supporting = conclaveString("pm_delete_footer"),
                            onClick = { showDelete = true },
                        )
                    }
                } else {
                    when (snapshot.providersState) {
                        ProvidersState.loading -> item("providersLoading") { AccountProvidersLoading() }
                        ProvidersState.failed -> item("providersFailed") { AccountProvidersFailed { account.retryProviders() } }
                        ProvidersState.none -> item("providersNone") {
                            AccountNote(conclaveString("pm_no_providers"), "account.noProviders", scheme.onSurfaceVariant)
                        }
                        ProvidersState.ready -> if (snapshot.offersGoogle) {
                            item("google") {
                                AccountGoogleButton(
                                    pending = snapshot.pendingProvider == AuthProviderKind.google.rawValue,
                                    enabled = !snapshot.isBusy,
                                    onClick = { account.signInWithGoogle() },
                                )
                            }
                        }
                    }
                    if (snapshot.errorKind == AccountErrorKind.signInFailed) {
                        item("signInFailed") {
                            AccountNote(conclaveString("pm_signin_failed"), "account.signInFailed", scheme.error, announces = true)
                        }
                    }
                    if (snapshot.showsAppleFootnote) {
                        item("appleFootnote") {
                            AccountNote(conclaveString("pm_apple_unavailable"), "account.appleFootnote", scheme.onSurfaceVariant)
                        }
                    }
                    item("guestName") {
                        AccountGuestNameField(
                            initialName = snapshot.guestName,
                            enabled = !snapshot.isBusy,
                            onCommit = { name -> account.setGuestName(name) },
                        )
                    }
                    if (onOpenSettings != null) {
                        item("settings") {
                            AccountActionItem(
                                title = conclaveString("set_title"),
                                identifier = "account.settings",
                                pending = false,
                                enabled = true,
                                onClick = onOpenSettings,
                            )
                        }
                    }
                    item("privacy") {
                        AccountActionItem(
                            title = conclaveString("pm_privacy_policy"),
                            identifier = "account.privacy",
                            pending = false,
                            enabled = true,
                            onClick = onOpenPrivacy,
                        )
                    }
                }
            }
        }
    }
    if (showDelete) {
        AlertDialog(
            onDismissRequest = { showDelete = false },
            title = { Text(conclaveString("pm_delete_title")) },
            text = { Text(conclaveString("pm_delete_message")) },
            confirmButton = {
                TextButton(
                    onClick = {
                        showDelete = false
                        account.deleteAccount()
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = scheme.error),
                    modifier = Modifier.testTag("account.delete.confirm"),
                ) {
                    Text(conclaveString("pm_delete"))
                }
            },
            dismissButton = {
                TextButton(onClick = { showDelete = false }, modifier = Modifier.testTag("account.delete.cancel")) {
                    Text(conclaveString("pm_cancel"))
                }
            },
            modifier = Modifier.testTag("account.delete.dialog"),
        )
    }
}

@Composable
private fun AccountContextBanner(context: AccountContext) {
    val text = if (context == AccountContext.signInRequired) {
        conclaveString("pm_sign_in_required")
    } else {
        conclaveString("pm_notice_session_expired")
    }
    ConclaveBanner(
        kind = ConclaveBannerKind.Info,
        text = text,
        identifier = "account.context",
        inCall = false,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

@Composable
private fun AccountProfileItem(snapshot: AccountSnapshot) {
    val providerLine = when (snapshot.provider) {
        AuthProviderKind.apple.rawValue -> conclaveString("pm_signed_in_with_apple")
        AuthProviderKind.google.rawValue -> conclaveString("pm_signed_in_with_google")
        else -> conclaveString("pm_signed_in")
    }
    val email = snapshot.email
    val showsEmail = email.isNotEmpty() && email != snapshot.name
    ListItem(
        leadingContent = { ConclaveAvatar(snapshot.name, snapshot.avatarSeed, ConclaveAvatarSize.row) },
        overlineContent = { Text(providerLine) },
        headlineContent = { Text(snapshot.name) },
        supportingContent = if (showsEmail) {
            { Text(email) }
        } else {
            null
        },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.testTag("account.profile").semantics(mergeDescendants = true) {},
    )
}

@Composable
private fun AccountActionItem(
    title: String,
    identifier: String,
    pending: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    color: Color = Color.Unspecified,
    supporting: String? = null,
) {
    val inProgress = conclaveString("ds_in_progress")
    ListItem(
        headlineContent = { Text(title, color = color) },
        supportingContent = if (supporting != null) {
            { Text(supporting) }
        } else {
            null
        },
        trailingContent = if (pending) {
            { CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp) }
        } else {
            null
        },
        colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surface),
        modifier = Modifier.testTag(identifier)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { if (pending) stateDescription = inProgress },
    )
}

@Composable
private fun AccountProvidersLoading() {
    Row(
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp).testTag("account.providers.loading")
            .semantics(mergeDescendants = true) {},
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
        Text(conclaveString("pm_providers_loading"), style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun AccountProvidersFailed(onRetry: () -> Unit) {
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("account.providers.failed")) {
        Text(conclaveString("pm_providers_failed"), style = MaterialTheme.typography.bodyMedium)
        TextButton(onClick = onRetry, modifier = Modifier.heightIn(min = 48.dp).testTag("account.providers.retry")) {
            Text(conclaveString("ds_try_again"))
        }
    }
}

@Composable
private fun AccountNote(text: String, identifier: String, color: Color, announces: Boolean = false) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = color,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag(identifier)
            .semantics { if (announces) liveRegion = LiveRegionMode.Polite },
    )
}

@Composable
private fun AccountGoogleButton(pending: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val context = LocalContext.current
    val markId = remember(context) { conclaveDrawableId(context, "google_g_mark") }
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).fillMaxWidth().heightIn(min = 56.dp)
            .testTag("account.google"),
        shape = CircleShape,
        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
    ) {
        if (pending) {
            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(8.dp))
        } else if (markId != 0) {
            Image(painterResource(markId), contentDescription = null, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(conclaveString("pm_continue_google"), style = MaterialTheme.typography.titleMedium)
    }
}

@Composable
private fun AccountGuestNameField(initialName: String, enabled: Boolean, onCommit: (String) -> Unit) {
    var draft by rememberSaveable { mutableStateOf(initialName) }
    var wasFocused by remember { mutableStateOf(false) }
    val focusManager = LocalFocusManager.current
    val latestDraft = rememberUpdatedState(draft)
    val latestCommit = rememberUpdatedState(onCommit)
    DisposableEffect(Unit) {
        onDispose { latestCommit.value(latestDraft.value) }
    }
    OutlinedTextField(
        value = draft,
        onValueChange = { value -> draft = AccountGuestNamePolicy.capped(value) },
        enabled = enabled,
        singleLine = true,
        label = { Text(conclaveString("pm_your_name")) },
        supportingText = {
            Row(verticalAlignment = Alignment.Top) {
                Text(conclaveString("pm_guest_footer"), modifier = Modifier.weight(1f))
                ConclaveCharacterCounter(
                    count = draft.length,
                    limit = AccountGuestNamePolicy.limit,
                    visibleFrom = AccountGuestNamePolicy.counterThreshold,
                    identifier = "account.guestName.counter",
                )
            }
        },
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = {
            onCommit(draft)
            focusManager.clearFocus()
        }),
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).fillMaxWidth().testTag("account.guestName")
            .onFocusChanged { state ->
                if (wasFocused && !state.isFocused) {
                    onCommit(draft)
                }
                wasFocused = state.isFocused
            },
    )
}
