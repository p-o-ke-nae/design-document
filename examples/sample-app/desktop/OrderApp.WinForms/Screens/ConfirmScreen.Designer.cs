namespace OrderApp.WinForms.Screens;

partial class ConfirmScreen
{
    private System.ComponentModel.IContainer components = null;

    protected override void Dispose(bool disposing)
    {
        if (disposing && (components != null))
        {
            components.Dispose();
        }
        base.Dispose(disposing);
    }

    #region Component Designer generated code

    private void InitializeComponent()
    {
        this.title = new System.Windows.Forms.Label();
        this.customerLabel = new System.Windows.Forms.Label();
        this.confirmCustomer = new System.Windows.Forms.Label();
        this.skuLabel = new System.Windows.Forms.Label();
        this.confirmSku = new System.Windows.Forms.Label();
        this.quantityLabel = new System.Windows.Forms.Label();
        this.confirmQuantity = new System.Windows.Forms.Label();
        this.submitError = new System.Windows.Forms.Label();
        this.back = new System.Windows.Forms.Button();
        this.submit = new System.Windows.Forms.Button();
        this.SuspendLayout();
        //
        // title
        //
        this.title.AutoSize = true;
        this.title.Font = new System.Drawing.Font("Yu Gothic UI", 13F, System.Drawing.FontStyle.Bold);
        this.title.Location = new System.Drawing.Point(0, 0);
        this.title.Name = "title";
        this.title.Size = new System.Drawing.Size(82, 25);
        this.title.TabIndex = 0;
        this.title.Text = "入力確認";
        //
        // customerLabel
        //
        this.customerLabel.AutoSize = true;
        this.customerLabel.ForeColor = System.Drawing.Color.FromArgb(71, 85, 105);
        this.customerLabel.Location = new System.Drawing.Point(0, 40);
        this.customerLabel.Name = "customerLabel";
        this.customerLabel.Size = new System.Drawing.Size(43, 15);
        this.customerLabel.TabIndex = 1;
        this.customerLabel.Text = "顧客名";
        //
        // confirmCustomer
        //
        this.confirmCustomer.AutoSize = true;
        this.confirmCustomer.Location = new System.Drawing.Point(96, 40);
        this.confirmCustomer.Name = "confirm-customer";
        this.confirmCustomer.Size = new System.Drawing.Size(0, 15);
        this.confirmCustomer.TabIndex = 2;
        //
        // skuLabel
        //
        this.skuLabel.AutoSize = true;
        this.skuLabel.ForeColor = System.Drawing.Color.FromArgb(71, 85, 105);
        this.skuLabel.Location = new System.Drawing.Point(0, 66);
        this.skuLabel.Name = "skuLabel";
        this.skuLabel.Size = new System.Drawing.Size(31, 15);
        this.skuLabel.TabIndex = 3;
        this.skuLabel.Text = "商品";
        //
        // confirmSku
        //
        this.confirmSku.AutoSize = true;
        this.confirmSku.Location = new System.Drawing.Point(96, 66);
        this.confirmSku.Name = "confirm-sku";
        this.confirmSku.Size = new System.Drawing.Size(0, 15);
        this.confirmSku.TabIndex = 4;
        //
        // quantityLabel
        //
        this.quantityLabel.AutoSize = true;
        this.quantityLabel.ForeColor = System.Drawing.Color.FromArgb(71, 85, 105);
        this.quantityLabel.Location = new System.Drawing.Point(0, 92);
        this.quantityLabel.Name = "quantityLabel";
        this.quantityLabel.Size = new System.Drawing.Size(31, 15);
        this.quantityLabel.TabIndex = 5;
        this.quantityLabel.Text = "数量";
        //
        // confirmQuantity
        //
        this.confirmQuantity.AutoSize = true;
        this.confirmQuantity.Location = new System.Drawing.Point(96, 92);
        this.confirmQuantity.Name = "confirm-quantity";
        this.confirmQuantity.Size = new System.Drawing.Size(0, 15);
        this.confirmQuantity.TabIndex = 6;
        //
        // submitError
        //
        this.submitError.AutoSize = true;
        this.submitError.ForeColor = System.Drawing.Color.FromArgb(185, 28, 28);
        this.submitError.Location = new System.Drawing.Point(0, 124);
        this.submitError.Name = "submit-error";
        this.submitError.Size = new System.Drawing.Size(0, 15);
        this.submitError.TabIndex = 7;
        this.submitError.Visible = false;
        //
        // back
        //
        this.back.Location = new System.Drawing.Point(0, 152);
        this.back.Name = "back";
        this.back.Size = new System.Drawing.Size(96, 30);
        this.back.TabIndex = 8;
        this.back.Text = "戻る";
        this.back.UseVisualStyleBackColor = true;
        this.back.Click += new System.EventHandler(this.back_Click);
        //
        // submit
        //
        this.submit.Location = new System.Drawing.Point(104, 152);
        this.submit.Name = "submit";
        this.submit.Size = new System.Drawing.Size(96, 30);
        this.submit.TabIndex = 9;
        this.submit.Text = "確定";
        this.submit.UseVisualStyleBackColor = true;
        this.submit.Click += new System.EventHandler(this.submit_Click);
        //
        // ConfirmScreen
        //
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.Controls.Add(this.title);
        this.Controls.Add(this.customerLabel);
        this.Controls.Add(this.confirmCustomer);
        this.Controls.Add(this.skuLabel);
        this.Controls.Add(this.confirmSku);
        this.Controls.Add(this.quantityLabel);
        this.Controls.Add(this.confirmQuantity);
        this.Controls.Add(this.submitError);
        this.Controls.Add(this.back);
        this.Controls.Add(this.submit);
        this.Name = "Confirm";
        this.Size = new System.Drawing.Size(592, 365);
        this.ResumeLayout(false);
        this.PerformLayout();
    }

    #endregion

    private System.Windows.Forms.Label title;
    private System.Windows.Forms.Label customerLabel;
    private System.Windows.Forms.Label confirmCustomer;
    private System.Windows.Forms.Label skuLabel;
    private System.Windows.Forms.Label confirmSku;
    private System.Windows.Forms.Label quantityLabel;
    private System.Windows.Forms.Label confirmQuantity;
    private System.Windows.Forms.Label submitError;
    private System.Windows.Forms.Button back;
    private System.Windows.Forms.Button submit;
}
